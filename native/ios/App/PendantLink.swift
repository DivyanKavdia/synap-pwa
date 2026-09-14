import Foundation
import CoreBluetooth

struct LinkFailure: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// Every delegate and operation runs on the recorder's serial queue.
final class PendantLink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let service = CBUUID(string: "4fa12345-0000-1000-8000-00805f9b34fb")
    static let audio = CBUUID(string: "4fa12346-0000-1000-8000-00805f9b34fb")
    static let control = CBUUID(string: "4fa12347-0000-1000-8000-00805f9b34fb")
    static let identity = CBUUID(string: "4fa1234c-0000-1000-8000-00805f9b34fb")
    static let events = CBUUID(string: "4fa1234e-0000-1000-8000-00805f9b34fb")
    static let recovery = CBUUID(string: "4fa1234f-0000-1000-8000-00805f9b34fb")
    enum OperationKind { case read, write(Data), subscribe }
    struct Operation {
        let id = UUID()
        let characteristic: CBCharacteristic
        let kind: OperationKind
        let completion: (Result<Data, Error>) -> Void
    }
    let queue: DispatchQueue
    private var central: CBCentralManager!
    private(set) var peripheral: CBPeripheral?
    private var characteristics: [CBUUID: CBCharacteristic] = [:]
    private var candidates: [UUID: CBPeripheral] = [:]
    private var operations: [Operation] = []
    private var operation: Operation?
    private var timeout: DispatchWorkItem?
    private var wantedID: UUID?
    private var discovering = false
    private(set) var connected = false
    var onDevice: ((UUID, String, Int) -> Void)?
    var onReady: (() -> Void)?
    var onDisconnected: ((String) -> Void)?
    var onMessage: ((String) -> Void)?
    var onValue: ((CBUUID, Data) -> Void)?

    init(queue: DispatchQueue, restoring id: UUID?) {
        self.queue = queue; wantedID = id
        super.init()
        central = CBCentralManager(delegate: self, queue: queue, options: [
            CBCentralManagerOptionRestoreIdentifierKey: "com.synap.recorder.central.v1",
            CBCentralManagerOptionShowPowerAlertKey: true
        ])
    }

    func scan() {
        guard central.state == .poweredOn else { onMessage?("Turn on Bluetooth and allow synap to use it."); return }
        central.scanForPeripherals(withServices: [Self.service], options: nil)
        onMessage?("Looking for your pendant…")
    }
    func connect(_ id: UUID) {
        guard central.state == .poweredOn else { wantedID = id; return }
        guard let target = candidates[id] ?? central.retrievePeripherals(withIdentifiers: [id]).first else { scan(); return }
        wantedID = id; central.stopScan()
        if let previous = peripheral, previous.identifier != id { disconnect() ; wantedID = id }
        peripheral = target; target.delegate = self
        if target.state == .connected { discover(target) }
        else if target.state != .connecting { central.connect(target, options: [CBConnectPeripheralOptionNotifyOnDisconnectionKey: true]) }
    }
    func reconnect() { if let id = wantedID { connect(id) } }
    func disconnect() {
        wantedID = nil; central.stopScan(); connected = false; discovering = false; characteristics.removeAll()
        failOperations(LinkFailure(message: "Bluetooth connection closed."))
        if let peripheral { central.cancelPeripheralConnection(peripheral) }
    }
    func perform(_ uuid: CBUUID, _ kind: OperationKind, completion: @escaping (Result<Data, Error>) -> Void) {
        guard connected, let characteristic = characteristics[uuid] else {
            completion(.failure(LinkFailure(message: "The pendant connection is not ready."))); return
        }
        operations.append(Operation(characteristic: characteristic, kind: kind, completion: completion)); pump()
    }
    private func pump() {
        guard operation == nil, connected, let peripheral, !operations.isEmpty else { return }
        let next = operations.removeFirst(); operation = next
        let expiry = DispatchWorkItem { [weak self] in
            guard let self, self.operation?.id == next.id else { return }
            self.connected = false
            self.failOperations(LinkFailure(message: "The pendant did not answer. Reconnecting…"))
            self.central.cancelPeripheralConnection(peripheral)
        }
        timeout = expiry; queue.asyncAfter(deadline: .now() + 8, execute: expiry)
        switch next.kind {
        case .read: peripheral.readValue(for: next.characteristic)
        case .write(let bytes): peripheral.writeValue(bytes, for: next.characteristic, type: .withResponse)
        case .subscribe:
            if next.characteristic.isNotifying { finish(.success(Data())) }
            else { peripheral.setNotifyValue(true, for: next.characteristic) }
        }
    }
    private func finish(_ result: Result<Data, Error>) {
        timeout?.cancel(); timeout = nil
        let current = operation; operation = nil
        current?.completion(result); pump()
    }
    private func failOperations(_ error: Error) {
        timeout?.cancel(); timeout = nil
        let all = (operation.map { [$0] } ?? []) + operations
        operation = nil; operations.removeAll()
        for item in all { item.completion(.failure(error)) }
    }
    private func discover(_ target: CBPeripheral) {
        guard !discovering, !connected else { return }
        discovering = true
        connected = false; characteristics.removeAll(); target.delegate = self
        target.discoverServices([Self.service])
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn { if let wantedID { connect(wantedID) } }
        else {
            connected = false; discovering = false; characteristics.removeAll(); failOperations(LinkFailure(message: "Bluetooth is unavailable."))
            onDisconnected?(central.state == .unauthorized ? "Allow Bluetooth in iPhone Settings → synap." : "Bluetooth is off. Received audio is safe.")
        }
    }
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        for target in restored {
            guard target.identifier == wantedID else { central.cancelPeripheralConnection(target); continue }
            peripheral = target; target.delegate = self; candidates[target.identifier] = target
            if target.state == .connected { discover(target) }
        }
    }
    func centralManager(_ central: CBCentralManager, didDiscover target: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        candidates[target.identifier] = target
        onDevice?(target.identifier, target.name ?? "synap pendant", RSSI.intValue)
    }
    func centralManager(_ central: CBCentralManager, didConnect target: CBPeripheral) {
        guard target.identifier == wantedID else { central.cancelPeripheralConnection(target); return }
        peripheral = target; discover(target)
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect target: CBPeripheral, error: Error?) {
        guard target.identifier == peripheral?.identifier else { return }
        connected = false; failOperations(error ?? LinkFailure(message: "Could not connect."))
        onDisconnected?(error?.localizedDescription ?? "Could not connect to the pendant.")
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral target: CBPeripheral, error: Error?) {
        guard target.identifier == peripheral?.identifier else { return }
        connected = false; discovering = false; characteristics.removeAll(); failOperations(error ?? LinkFailure(message: "Pendant disconnected."))
        onDisconnected?("Pendant disconnected. Waiting for it to return…")
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === self.peripheral else { return }
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == Self.service }) else {
            onMessage?("This device does not expose the synap recording service."); disconnect(); return
        }
        peripheral.discoverCharacteristics([Self.audio, Self.control, Self.identity, Self.events, Self.recovery], for: service)
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard peripheral === self.peripheral else { return }
        discovering = false
        guard error == nil else { onMessage?(error!.localizedDescription); disconnect(); return }
        for characteristic in service.characteristics ?? [] { characteristics[characteristic.uuid] = characteristic }
        guard [Self.audio, Self.control, Self.identity, Self.recovery].allSatisfy({ characteristics[$0] != nil }) else {
            onMessage?("Update the pendant firmware in synap before using the iPhone recorder."); disconnect(); return
        }
        connected = true; onReady?()
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === self.peripheral, connected else { return }
        let current = operation
        if let error {
            if current?.characteristic === characteristic { finish(.failure(error)) }
            return
        }
        guard let value = characteristic.value else { return }
        // Handle recorder data before a read completion can enqueue another operation.
        onValue?(characteristic.uuid, value)
        if current?.id == operation?.id, current?.characteristic === characteristic,
           case .read? = current?.kind { finish(.success(value)) }
    }
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === self.peripheral, operation?.characteristic === characteristic,
              case .write? = operation?.kind else { return }
        finish(error.map { .failure($0) } ?? .success(Data()))
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === self.peripheral, operation?.characteristic === characteristic,
              case .subscribe? = operation?.kind else { return }
        if let error { finish(.failure(error)) }
        else if characteristic.isNotifying { finish(.success(Data())) }
        else { finish(.failure(LinkFailure(message: "Audio notifications were not enabled."))) }
    }
}
