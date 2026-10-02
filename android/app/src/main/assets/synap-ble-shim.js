/* Synap Web Bluetooth shim for Android WebView.
 *
 * Android System WebView has never implemented Web Bluetooth. This file puts a
 * `navigator.bluetooth` in front of the PWA that is backed by native Android BLE
 * through the `SynapBleNative` JavascriptInterface, so app.js, devices/*, ota.js,
 * event-channel.js and disconnect-protection.js all run completely unmodified.
 *
 * It implements the subset the PWA actually uses, with matching semantics:
 *   navigator.bluetooth.requestDevice / getDevices / getAvailability
 *   device.id / name / gatt / watchAdvertisements / forget
 *   device 'gattserverdisconnected' and 'advertisementreceived'
 *   gatt.connect / disconnect / connected / getPrimaryService
 *   service.getCharacteristic
 *   characteristic.readValue / writeValueWithResponse / writeValueWithoutResponse
 *   characteristic.startNotifications / stopNotifications / value
 *   characteristic 'characteristicvaluechanged'
 *
 * It must be injected before any page script (addDocumentStartJavaScript).
 */
(function (root) {
  'use strict';

  var native = root.SynapBleNative;
  if (!native) return;
  if (root.navigator && root.navigator.bluetooth && root.navigator.bluetooth.__synapNativeShim) return;

  // ------------------------------------------------------------ request plumbing

  var sequence = 0;
  var waiting = Object.create(null);

  function request(invoke) {
    var id = 'r' + (++sequence);
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      try {
        invoke(id);
      } catch (error) {
        delete waiting[id];
        reject(error);
      }
    });
  }

  function failure(event) {
    var error = new Error(event.message || 'Bluetooth operation failed');
    // app.js branches on error.name === 'TimeoutError' to decide whether a
    // native request may still be in flight, so the name has to survive.
    if (event.name) error.name = event.name;
    return error;
  }

  // -------------------------------------------------------------------- helpers

  function normaliseUuid(value) {
    if (typeof value === 'number') {
      return (value >>> 0).toString(16).padStart(8, '0') + '-0000-1000-8000-00805f9b34fb';
    }
    var text = String(value || '').toLowerCase();
    if (/^[0-9a-f]{1,4}$/.test(text)) {
      return text.padStart(8, '0') + '-0000-1000-8000-00805f9b34fb';
    }
    if (/^[0-9a-f]{8}$/.test(text)) {
      return text + '-0000-1000-8000-00805f9b34fb';
    }
    return text;
  }

  function toBytes(source) {
    if (source == null) return new Uint8Array(0);
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView(source)) {
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    if (Array.isArray(source)) return new Uint8Array(source);
    return new Uint8Array(0);
  }

  var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function encodeBase64(bytes) {
    var out = '';
    var i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var block = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += BASE64[(block >> 18) & 63] + BASE64[(block >> 12) & 63] +
        BASE64[(block >> 6) & 63] + BASE64[block & 63];
    }
    var remaining = bytes.length - i;
    if (remaining === 1) {
      var one = bytes[i] << 16;
      out += BASE64[(one >> 18) & 63] + BASE64[(one >> 12) & 63] + '==';
    } else if (remaining === 2) {
      var two = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += BASE64[(two >> 18) & 63] + BASE64[(two >> 12) & 63] + BASE64[(two >> 6) & 63] + '=';
    }
    return out;
  }

  var REVERSE = (function () {
    var table = new Uint8Array(128);
    for (var i = 0; i < BASE64.length; i++) table[BASE64.charCodeAt(i)] = i;
    return table;
  })();

  function decodeBase64(text) {
    var clean = text.replace(/=+$/, '');
    var length = (clean.length * 3) >> 2;
    var bytes = new Uint8Array(length);
    var accumulator = 0;
    var bits = 0;
    var index = 0;
    for (var i = 0; i < clean.length; i++) {
      accumulator = (accumulator << 6) | REVERSE[clean.charCodeAt(i)];
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes[index++] = (accumulator >> bits) & 255;
      }
    }
    return new DataView(bytes.buffer, 0, index);
  }

  // A minimal EventTarget: WebView has a real one, but these objects also need
  // `onxxx`-free, listener-identity-stable behaviour across reconnects.
  function Emitter() {
    this._listeners = Object.create(null);
  }
  Emitter.prototype.addEventListener = function (type, handler) {
    if (typeof handler !== 'function') return;
    (this._listeners[type] || (this._listeners[type] = [])).push(handler);
  };
  Emitter.prototype.removeEventListener = function (type, handler) {
    var list = this._listeners[type];
    if (!list) return;
    var at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  };
  Emitter.prototype.dispatchEvent = function (event) {
    var list = this._listeners[event.type];
    if (!list || !list.length) return true;
    event.target = event.target || this;
    list.slice().forEach(function (handler) {
      try {
        handler.call(this, event);
      } catch (error) {
        console.error('[synap ble] listener for ' + event.type + ' threw', error);
      }
    }, this);
    return true;
  };

  // ----------------------------------------------------------- characteristic

  function Characteristic(service, uuid, properties) {
    Emitter.call(this);
    this.service = service;
    this.uuid = uuid;
    this.value = null;
    this.properties = properties || {};
    this._notifying = false;
  }
  Characteristic.prototype = Object.create(Emitter.prototype);
  Characteristic.prototype.constructor = Characteristic;

  Characteristic.prototype.readValue = function () {
    var self = this;
    var device = this.service.device;
    return request(function (id) {
      native.read(device.id, self.service.uuid, self.uuid, id);
    }).then(function (event) {
      self.value = decodeBase64(event.value || '');
      return self.value;
    });
  };

  Characteristic.prototype._write = function (value, withResponse) {
    var self = this;
    var device = this.service.device;
    var payload = encodeBase64(toBytes(value));
    return request(function (id) {
      native.write(device.id, self.service.uuid, self.uuid, payload, withResponse, id);
    }).then(function () {
      return undefined;
    });
  };

  Characteristic.prototype.writeValueWithResponse = function (value) {
    return this._write(value, true);
  };
  Characteristic.prototype.writeValueWithoutResponse = function (value) {
    return this._write(value, false);
  };
  Characteristic.prototype.writeValue = function (value) {
    return this._write(value, !this.properties.writeWithoutResponse);
  };

  Characteristic.prototype.startNotifications = function () {
    var self = this;
    var device = this.service.device;
    return request(function (id) {
      native.setNotify(device.id, self.service.uuid, self.uuid, true, id);
    }).then(function () {
      self._notifying = true;
      return self;
    });
  };

  Characteristic.prototype.stopNotifications = function () {
    var self = this;
    var device = this.service.device;
    if (!this._notifying) return Promise.resolve(this);
    return request(function (id) {
      native.setNotify(device.id, self.service.uuid, self.uuid, false, id);
    }).then(function () {
      self._notifying = false;
      return self;
    }).catch(function () {
      // A link that already dropped cannot unsubscribe, and the PWA's cleanup
      // path must not reject just because the pendant went away first.
      self._notifying = false;
      return self;
    });
  };

  // ------------------------------------------------------------------ service

  function Service(device, uuid, characteristics) {
    this.device = device;
    this.uuid = uuid;
    this.isPrimary = true;
    this._characteristics = characteristics;
    this._cache = Object.create(null);
  }

  Service.prototype.getCharacteristic = function (uuid) {
    var wanted = normaliseUuid(uuid);
    var cached = this._cache[wanted];
    if (cached) return Promise.resolve(cached);
    var found = null;
    for (var i = 0; i < this._characteristics.length; i++) {
      if (normaliseUuid(this._characteristics[i].uuid) === wanted) {
        found = this._characteristics[i];
        break;
      }
    }
    if (!found) {
      var error = new Error('No characteristic ' + wanted + ' on ' + this.uuid);
      error.name = 'NotFoundError';
      return Promise.reject(error);
    }
    var characteristic = new Characteristic(this, wanted, found.properties);
    this._cache[wanted] = characteristic;
    return Promise.resolve(characteristic);
  };

  // --------------------------------------------------------------------- gatt

  function Gatt(device) {
    this.device = device;
    this._services = Object.create(null);
  }

  Object.defineProperty(Gatt.prototype, 'connected', {
    get: function () {
      try {
        return Boolean(native.isConnected(this.device.id));
      } catch (error) {
        return false;
      }
    },
  });

  Gatt.prototype.connect = function () {
    var self = this;
    var device = this.device;
    return request(function (id) {
      native.connect(device.id, id);
    }).then(function () {
      // Native discovery already ran; rebuild the object graph so a reconnect
      // never hands back characteristics bound to the previous link.
      self._services = Object.create(null);
      device._generation++;
      return self;
    });
  };

  Gatt.prototype.disconnect = function () {
    try {
      native.disconnect(this.device.id);
    } catch (error) {
      /* Already gone. */
    }
  };

  Gatt.prototype.getPrimaryService = function (uuid) {
    var wanted = normaliseUuid(uuid);
    var cached = this._services[wanted];
    if (cached) return Promise.resolve(cached);

    if (!this.connected) {
      var offline = new Error('GATT Server is disconnected.');
      offline.name = 'NetworkError';
      return Promise.reject(offline);
    }

    var inventory;
    try {
      inventory = JSON.parse(native.inventory(this.device.id) || '[]');
    } catch (error) {
      inventory = [];
    }
    for (var i = 0; i < inventory.length; i++) {
      if (normaliseUuid(inventory[i].uuid) === wanted) {
        var service = new Service(this.device, wanted, inventory[i].characteristics || []);
        this._services[wanted] = service;
        return Promise.resolve(service);
      }
    }
    var missing = new Error('No service ' + wanted + ' on this device');
    missing.name = 'NotFoundError';
    return Promise.reject(missing);
  };

  // ------------------------------------------------------------------- device

  var deviceRegistry = Object.create(null);

  function Device(id, name) {
    Emitter.call(this);
    this.id = id;
    this.name = name || null;
    this.gatt = new Gatt(this);
    this._generation = 0;
    this._watchController = null;
  }
  Device.prototype = Object.create(Emitter.prototype);
  Device.prototype.constructor = Device;

  Device.prototype.watchAdvertisements = function (options) {
    var self = this;
    var signal = options && options.signal;
    try {
      native.watchAdvertisements(this.id);
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal) {
      signal.addEventListener('abort', function () {
        try {
          native.unwatchAdvertisements(self.id);
        } catch (error) {
          /* Nothing to stop. */
        }
      });
    }
    return Promise.resolve();
  };

  Device.prototype.forget = function () {
    try {
      native.forgetDevice(this.id);
    } catch (error) {
      /* Nothing stored. */
    }
    return Promise.resolve();
  };

  function deviceFor(id, name) {
    var existing = deviceRegistry[id];
    if (existing) {
      if (name && !existing.name) existing.name = name;
      return existing;
    }
    var device = new Device(id, name);
    deviceRegistry[id] = device;
    return device;
  }

  // ----------------------------------------------------------- event delivery

  function handle(event) {
    if (event.type === 'settle') {
      var pending = waiting[event.requestId];
      if (!pending) return;
      delete waiting[event.requestId];
      if (event.ok) pending.resolve(event);
      else pending.reject(failure(event));
      return;
    }

    var device = deviceRegistry[event.id];
    if (!device) return;

    if (event.type === 'characteristicvaluechanged') {
      var service = device.gatt._services[normaliseUuid(event.service)];
      if (!service) return;
      var characteristic = service._cache[normaliseUuid(event.characteristic)];
      if (!characteristic) return;
      characteristic.value = decodeBase64(event.value || '');
      characteristic.dispatchEvent({
        type: 'characteristicvaluechanged',
        target: characteristic,
      });
      return;
    }

    if (event.type === 'gattserverdisconnected') {
      device.gatt._services = Object.create(null);
      device.dispatchEvent({ type: 'gattserverdisconnected', target: device });
      return;
    }

    if (event.type === 'advertisementreceived') {
      device.dispatchEvent({
        type: 'advertisementreceived',
        target: device,
        device: device,
        rssi: event.rssi,
        name: event.name || device.name,
      });
    }
  }

  root.__synapBleNative = {
    dispatch: function (events) {
      for (var i = 0; i < events.length; i++) {
        try {
          handle(events[i]);
        } catch (error) {
          console.error('[synap ble] dispatch failed', error);
        }
      }
    },
    availability: function (available) {
      bluetooth.dispatchEvent({ type: 'availabilitychanged', value: Boolean(available) });
    },
  };

  // ------------------------------------------------------- navigator.bluetooth

  var bluetooth = new Emitter();

  bluetooth.__synapNativeShim = true;

  bluetooth.getAvailability = function () {
    try {
      return Promise.resolve(Boolean(native.isSupported()));
    } catch (error) {
      return Promise.resolve(false);
    }
  };

  bluetooth.requestDevice = function (options) {
    return request(function (id) {
      native.requestDevice(JSON.stringify(options || {}), id);
    }).then(function (event) {
      return deviceFor(event.id, event.name);
    });
  };

  bluetooth.getDevices = function () {
    var rows;
    try {
      rows = JSON.parse(native.getDevices() || '[]');
    } catch (error) {
      rows = [];
    }
    return Promise.resolve(rows.map(function (row) {
      return deviceFor(row.id, row.name);
    }));
  };

  Object.defineProperty(root.navigator, 'bluetooth', {
    value: bluetooth,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}(window));
