# Audio path: capture once, preserve the source

The default path is now microphone → unconditioned PCM16 → Bluetooth → local
PCM journal → identical WAV upload → cloud storage → the full stored WAV to ASR. Entirely zero windows retain their
source and receive an empty transcript without a model call.
Noise reduction is an explicit preview/export copy only.

## Audit findings and changes

| Stage | Previous behavior | Current behavior |
| --- | --- | --- |
| Firmware capture | Signed I2S conversion followed by a stateful 70 Hz high-pass filter | Signed I2S conversion only; filter and state removed on C3 and S3 |
| Bluetooth | Every frame encoded as lossy IMA ADPCM | Uncompressed PCM16 preferred at MTU ≥185; ADPCM retained below that threshold |
| Firmware recovery | Compressed frames retained in a volatile ring | Original PCM retained; only a constrained-link send invokes ADPCM |
| App journal/playback | Stores PCM decoded from received packets; gaps preserve time | Same behavior, with per-format frame counts retained through compaction/recovery |
| App cloud upload | Conditional local RNNoise with up to a 12-second budget; cloud could receive a different waveform from playback | New uploads send original WAV bytes and persist the exact retry body |
| Cloud ASR | Samples with magnitude ≤2 treated as silence; silent windows skipped and long silent boundaries trimmed | Every WAV with any nonzero sample is sent unchanged; entirely zero windows retain their source and skip ASR |
| Explicit enhancement | Local model preview/export | Remains a separate copy; never selected automatically for a new upload |
| Speaker identification | Extracts speaker-specific excerpts for embeddings | Separate derived work; does not replace source WAV or ASR audio |
| Desktop meetings | Browser echo cancellation, noise suppression, automatic gain, mixing and resampling | Noise suppression and automatic gain disabled; echo cancellation retained to avoid recapturing the meeting speaker output; mix/resample still required |

Voice enrollment already requests browser noise suppression, gain control and
echo cancellation off. Browser/device drivers and the microphone's internal
ADC/filtering are outside the firmware DSP path.

These processing layers were confirmed in code; their removal does not establish
that they caused every reported fault. The supplied robotic recording had an
independent, confirmed one-byte PCM alignment error. The pending alignment fix
is retained in this change set: malformed source data is rejected and preserved
for explicit recovery. See [the recording investigation](ROBOTIC_AUDIO_2026-09-14.md).
Earlier missing Bluetooth frames and received near-silent samples remain distinct
conditions; neither can be reconstructed by removing processing.

## Uncompressed transport and hardware budgets

The existing protocol-v2 wire format already supports uncompressed little-endian
PCM16, so control commands, status packet length, sample rate, frame duration and
older PWA compatibility remain unchanged. Protocol v3 is the ADPCM fallback.
Both formats decode to 800 mono samples per 50 ms frame.

| Resource | C3 SuperMini | S3 SuperMini with PSRAM |
| --- | --- | --- |
| Preferred source stream | 16 kHz × 16-bit mono PCM, 256 kb/s | Same |
| PCM at MTU 185 / 247 / 517 | 10 / 7 / 4 notifications per frame | Same |
| Fallback at MTU 32–184 | 404-byte ADPCM frames, 64.64 kb/s | Same |
| MTU below 32 | Recording refused | Recording refused |
| Volatile PCM recovery | 25 frames, 1.25 s, ~40 KB | 600 frames, 30 s, ~965 KB |
| Allocation fallback | Recovery unavailable when internal free heap is insufficient | Uses the C3-sized pool if PSRAM allocation fails and internal heap permits |

Rates exclude BLE headers and retries. The PCM threshold bounds notification
count; it is an implementation policy, **not a measured radio bandwidth test**.
A large MTU alone cannot guarantee that a particular phone sustains the stream.
Normal pacing remains 45 ms/frame; recovery catch-up uses 30 ms only with at most
five fragments/frame. Retry, queue-drop, packet-gap and disconnect evidence stay
visible. The format is selected at START or RESUME; there is no hidden switch
within an active connection. A reconnect with a different MTU can change format,
which is reflected in the saved frame counts.

The microphone provides 24 significant bits in a 32-bit I2S slot. Existing
conversion retains the upper 16 signed bits; it discards eight lower significant
bits and does not add digital gain. Uncompressed PCM16 is lossless from that
conversion onward on received frames, not a claim of raw 24-bit capture.
24-bit transport would require a different app/storage/ASR format contract and
50% more audio bandwidth than PCM16. The microphone's internal filters remain.
[INMP441 manufacturer datasheet](https://product.tdk.com/system/files/dam/doc/product/sw_piezo/mic/mems-mic/data_sheet/inmp441.pdf).

## Storage, retries and observability

Background delivery, the received-audio clock and replay over a retained BLE
connection are covered in [Background recording](BACKGROUND_RECORDING.md).
Bluefy/iOS suspension remains a platform constraint; the short recovery buffer
cannot preserve a long recording while the web page is stopped.

- Raw packets retain their actual transport (`pcm16` or `adpcm`). Complete-frame
  counts survive journal compaction and crash recovery. Recording details show
  uncompressed, compressed or mixed audio; older unlabelled frames stay unknown.
- Connection health shows PCM16 or ADPCM and the actual MTU/fragment count.
  Firmware diagnostics flags add `0x40` for no capture DSP and `0x80` for selected
  PCM transport; the existing 48-byte diagnostic layout is preserved.
- Local upload metadata marks new request bodies `source-pcm-v1`. Pre-upgrade
  cached request bodies remain unchanged because the cloud may have accepted
  them before the phone saw a response. They are not relabelled as unprocessed.
- SHA-256 checks, authenticated encrypted storage, strict WAV validation and
  timestamp-to-sample alignment remain. ASR input is the decrypted stored upload, except the exact-zero shortcut above.
  `stored-upload-v1` on new cloud transcriptions records this backend policy.
- Missing frames become timeline gaps with explicit missing-audio counts. They
  are never presented as microphone silence or as recovered speech.
- Quiet windows containing even one ±1 sample reach ASR unchanged, including all
  silent boundaries. Only an entirely zero window skips the model; its source
  stays stored. This keeps the latest exact-zero safeguard without an amplitude
  threshold or silence cropping.

## Verification and acceptance

Native tests exercise production capture on both materialized boards: all 65,536
signed PCM16 values, quiet/DC input, non-aligned partial I2S reads, driver recovery
and cancellation. Transport tests exercise all 65,536 possible MTUs, exact PCM
bytes, unchanged ADPCM golden bytes, pacing, congestion and connection races.
Recovery tests compare every retained/replayed PCM sample and verify allocation,
rollover, token ownership, STOP drain and bounded overflow. Both real board builds
use Arduino ESP32 3.3.5; S3 uses Adafruit NeoPixel 1.15.2.

Browser tests carry generated raw notifications through IndexedDB, compaction,
WAV creation, upload selection and native playback at the packet budgets for
MTUs 185/247/517. PCM byte comparisons are exact; native playback allows the
browser's PCM-to-float full-scale convention. Backend request tests compare every
ASR input byte, including ±1/±2 samples and silent boundaries, and preserve
original window timestamps. Provider retry tests preserve the same input.

Physical acceptance is still required: update app and firmware, record C3 and S3
for 10–15 minutes, verify PCM16 in Connection health, listen to both local and
cloud-source downloads, and inspect capture drops, notification rejects and gap
counts. Include quiet speech, brief RF interruptions, STOP drain and battery/USB
power. Verify the firmware update retains the `synap-os1-build#` naming and the
correct target. Host tests and successful board builds cannot certify RF
throughput, microphone wiring, acoustics or sound quality on physical devices.
