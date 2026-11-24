// Runs inside Google Meet (MAIN world).
//
// Meet carries captions, participant names and caption settings over WebRTC
// data channels on the meeting's peer connection, as small protobuf messages
// (sometimes gzipped):
//   "collections"   - participant devices: device id -> display name
//   "captions"      - older caption stream
//   "captions_v2"   - current caption stream; the client acks each utterance
//   "media-session" - session settings, including the caption language
//   "p2p"           - Meet moving a small call to a direct link
// Some of these Meet's server opens (a "datachannel" event), others Meet's
// page opens itself (createDataChannel), so both are watched.
// Opening the "captions" and "captions_v2" channels ourselves and setting the
// caption language over media-session is what asks Meet's server to start
// sending captions, so nothing shows on screen. Channels that drop are
// reopened, and when people talk but no captions come the request is made
// again.
// The participant list is also fetched once over HTTP
// (MeetingSpaceService/SyncMeetingSpaceCollections), and that request names
// our own device.
(() => {
  if (window.__earshotMeetHook) return;
  window.__earshotMeetHook = true;

  // Sent with every event (Earshot.HOOK_VERSION): a copy left running by an
  // older Earshot is told apart by it.
  const HOOK = 3;
  // Put in after the page had loaded (Earshot installed or reloaded with the
  // tab open). A call already under way is then out of reach: its connection
  // and caption channels were made before this could watch them.
  const late = document.readyState !== "loading";

  const OUT = "earshot:page";
  const IN = "earshot:cmd";
  const SYNC_COLLECTIONS = "/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections";
  const CAPTION_LABELS = ["captions", "captions_v2"];

  const log = [];
  function note(message, extra) {
    log.push({ at: new Date().toISOString(), message, extra });
    if (log.length > 200) log.shift();
  }

  // Meeting code from the URL: meet.google.com/abc-defg-hij
  // Read each time: a call started from meet.google.com/new only gets its code once Meet moves the address.
  const currentRef = () => /^\/(?:meet\/)?([a-z]+-[a-z]+-[a-z]+)/i.exec(location.pathname)?.[1] || null;

  function emit(type, data = {}) {
    try {
      document.documentElement.dispatchEvent(
        new CustomEvent(OUT, { detail: JSON.stringify({ type, platform: "meet", hook: HOOK, ref: currentRef(), ...data }) })
      );
    } catch (err) {
      note("emit failed", String(err));
    }
  }

  // ---------------------------------------------------------------- protobuf

  // Reads one message into { fieldNumber: [values] }. Varints come back as
  // strings when they don't fit in a JS number exactly.
  function readMessage(bytes) {
    const fields = {};
    let pos = 0;
    const varint = () => {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        if (pos >= bytes.length) throw new Error("truncated varint");
        const b = bytes[pos++];
        result |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) return result;
        shift += 7n;
        if (shift > 70n) throw new Error("varint too long");
      }
    };
    while (pos < bytes.length) {
      const key = Number(varint());
      const field = key >>> 3;
      const wire = key & 7;
      if (field === 0) throw new Error("field 0");
      let value;
      if (wire === 0) {
        const big = varint();
        value = big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
      } else if (wire === 2) {
        const len = Number(varint());
        if (pos + len > bytes.length) throw new Error("truncated field");
        value = bytes.subarray(pos, pos + len);
        pos += len;
      } else if (wire === 1) {
        pos += 8;
        continue;
      } else if (wire === 5) {
        pos += 4;
        continue;
      } else throw new Error(`wire type ${wire}`);
      (fields[field] = fields[field] || []).push(value);
    }
    return fields;
  }

  const textDecoder = new TextDecoder();
  const first = (fields, n) => fields?.[n]?.[0];
  const str = (fields, n) => {
    const v = first(fields, n);
    return v instanceof Uint8Array ? textDecoder.decode(v) : undefined;
  };
  const sub = (fields, n) => {
    const v = first(fields, n);
    return v instanceof Uint8Array ? readMessage(v) : undefined;
  };
  // Follow a chain of nested message fields: path(fields, 1, 2, 13) -> fields.1.2.13
  const path = (fields, ...ns) => ns.reduce((f, n) => (f ? sub(f, n) : undefined), fields);

  function writeVarint(out, value) {
    let v = BigInt(value);
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
  }
  // encode([[1, 5], [3, "text"], [4, [[1, 2n]]]]) -> bytes.
  // number/bigint -> varint, string -> UTF-8 bytes, array -> nested message.
  function encode(entries) {
    const out = [];
    for (const [field, value] of entries) {
      if (typeof value === "number" || typeof value === "bigint") {
        writeVarint(out, (field << 3) | 0);
        writeVarint(out, value);
      } else {
        const body = Array.isArray(value) ? encode(value) : value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
        writeVarint(out, (field << 3) | 2);
        writeVarint(out, body.length);
        for (const b of body) out.push(b);
      }
    }
    return Uint8Array.from(out);
  }

  // Some channels gzip their payloads, occasionally behind a 3-byte prefix.
  const isGzip = (b, at = 0) => b.length > at + 2 && b[at] === 0x1f && b[at + 1] === 0x8b && b[at + 2] === 0x08;
  async function unwrap(data) {
    let bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    if (!bytes) return null;
    const at = isGzip(bytes) ? 0 : isGzip(bytes, 3) ? 3 : -1;
    if (at < 0) return bytes;
    const stream = new Blob([bytes.subarray(at)]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---------------------------------------------------------------- participants

  const names = new Map(); // device id -> display name
  let selfDevice = null;

  function addDevices(devices) {
    const fresh = [];
    for (const d of devices) {
      if (!d.id || !d.name || names.get(d.id) === d.name) continue;
      names.set(d.id, d.name);
      fresh.push({ id: d.id, name: d.name });
    }
    if (fresh.length) emit("roster", { people: fresh });
  }

  // collections channel: device at fields 1 > 2 > 13 > 1 > 2, holding {1: id, 2: name}
  function deviceFromCollections(bytes) {
    try {
      const d = path(readMessage(bytes), 1, 2, 13, 1, 2);
      const id = str(d, 1);
      const name = str(d, 2);
      return id && name ? { id, name } : null;
    } catch {
      return null;
    }
  }

  // SyncMeetingSpaceCollections response: fields 2 > 2 > repeated 2 of {1: id, 2: name}
  function devicesFromSync(bytes) {
    try {
      const holder = path(readMessage(bytes), 2, 2);
      return (holder?.[2] || [])
        .map((b) => readMessage(b))
        .map((d) => ({ id: str(d, 1), name: str(d, 2) }))
        .filter((d) => d.id && d.name);
    } catch {
      return [];
    }
  }

  function nameFor(deviceId) {
    if (names.has(deviceId)) return { name: names.get(deviceId), resolved: true };
    return { name: `Participant ${deviceId.slice(-4)}`, resolved: false };
  }

  // ---------------------------------------------------------------- captions

  const sent = new Map(); // caption id -> { version, text }
  const aliases = new Map(); // caption id from one channel -> id already used for the same words
  const recent = new Map(); // "device|text" -> { id, at } for matching the two channels
  let sawV2 = false;

  function pruneRecent(now) {
    if (recent.size < 400) return;
    for (const [k, v] of recent) if (now - v.at > 3000) recent.delete(k);
  }

  // The two caption channels can carry the same utterance under different
  // ids. When one channel repeats words another just sent, reuse that id.
  function canonicalId(raw) {
    if (aliases.has(raw.id)) return aliases.get(raw.id);
    const now = Date.now();
    const key = `${raw.deviceId}|${raw.text}`;
    const seen = recent.get(key);
    if (seen && seen.id !== raw.id && now - seen.at < 1500 && seen.channel !== raw.channel) {
      aliases.set(raw.id, seen.id);
      return seen.id;
    }
    recent.set(key, { id: raw.id, at: now, channel: raw.channel });
    pruneRecent(now);
    return raw.id;
  }

  function emitCaption(raw) {
    if (!raw.deviceId || !raw.text) return;
    const id = canonicalId(raw);
    const last = sent.get(id);
    if (last && (last.version > raw.version || last.text === raw.text)) return;
    sent.set(id, { version: raw.version, text: raw.text });
    const who = nameFor(raw.deviceId);
    emit("captions", {
      captions: [
        {
          id,
          speakerId: raw.deviceId,
          speaker: who.name,
          speakerResolved: who.resolved,
          text: raw.text.trim(),
          language: raw.language ?? null,
          at: Date.now(),
        },
      ],
    });
  }

  // captions_v2: {1: utterance {1: utteranceId, 2: version, 3: caption {3: text, 4: language, 6: deviceId}}}
  // Since about 2026-11 Meet wraps the utterance one level deeper,
  // {1: {1: utterance, ...}}, and also sends packets with no caption in them
  // (state and timing). Both shapes are read; a packet without a caption is a
  // control message, not a failure.
  const CONTROL = { control: true };
  function parseV2(bytes) {
    let u = sub(readMessage(bytes), 1);
    if (u && first(u, 1) instanceof Uint8Array) u = sub(u, 1);
    if (!u) return CONTROL;
    const caption = sub(u, 3);
    if (!caption) return CONTROL;
    const deviceId = str(caption, 6);
    const utteranceId = first(u, 1);
    if (!deviceId || utteranceId === undefined || utteranceId instanceof Uint8Array) return null;
    return {
      channel: "v2",
      utteranceId,
      version: Number(first(u, 2) ?? 0),
      id: `${utteranceId}/${deviceId}`,
      deviceId,
      text: str(caption, 3) ?? "",
      language: str(caption, 4) ?? null,
    };
  }

  // captions: {1: message {1: deviceId, 2: messageId, 3: version, 6: text, 8: languageId}, 2: control}
  function parseLegacy(bytes) {
    const outer = readMessage(bytes);
    if (first(outer, 2) !== undefined) return null; // control message
    const m = sub(outer, 1);
    const deviceId = str(m, 1);
    const messageId = first(m, 2);
    if (!deviceId || !messageId) return null;
    return {
      channel: "legacy",
      id: `${messageId}/${deviceId}`,
      version: Number(first(m, 3) ?? 0),
      deviceId,
      text: str(m, 6) ?? "",
      language: first(m, 8) ?? null,
    };
  }

  // Ack for a captions_v2 utterance we received on a channel we opened.
  const ackV2 = (utteranceId, version) => encode([[1, [[1, [[1, BigInt(utteranceId)], [2, version], [3, 1]]]]]]);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isClosed = (pc) => !pc || pc.connectionState === "closed" || pc.connectionState === "failed" || pc.signalingState === "closed";
  const whenOpen = (channel, fn) => (channel.readyState === "open" ? fn() : channel.addEventListener("open", fn, { once: true }));

  const wiredChannels = new WeakSet();
  const ownChannels = new WeakSet(); // channels Earshot opened
  const meetOwnsV2 = new WeakSet(); // connections where Meet opened its own captions_v2
  const currentChannel = new Map(); // caption label -> { channel, pc } adopted last
  const channelsSeen = []; // every data channel, for Debug info
  const rejectedSamples = []; // the first caption packets we couldn't read, for Debug info
  let captionsSeen = 0;
  let packetsSeen = 0;
  let packetsRejected = 0;
  let controlPackets = 0; // packets on a caption channel with no caption in them
  const controlSamples = []; // the latest of those, for Debug info
  let lastPacketAt = 0;
  let creatingOwn = false;
  let channelIds = 50000;

  function noteChannel(channel, origin) {
    channelsSeen.push({ label: channel.label, origin, id: channel.id ?? null, at: new Date().toISOString(), channel });
    if (channelsSeen.length > 60) channelsSeen.shift();
  }

  function wireCaptionChannel(channel) {
    if (wiredChannels.has(channel)) return;
    wiredChannels.add(channel);
    note("listening on caption channel", { label: channel.label, own: ownChannels.has(channel) });
    channel.addEventListener("message", async (event) => {
      packetsSeen += 1;
      let bytes = null;
      try {
        bytes = await unwrap(event.data);
        if (!bytes) return;
        if (channel.label === "captions_v2") {
          const raw = parseV2(bytes);
          if (raw === CONTROL) return control(channel.label, bytes);
          if (!raw) return rejected(channel.label, bytes);
          heard();
          sawV2 = true;
          if (ownChannels.has(channel)) {
            try {
              channel.send(ackV2(raw.utteranceId, raw.version));
            } catch {}
          }
          captionsSeen += 1;
          emitCaption(raw);
        } else {
          const raw = parseLegacy(bytes);
          if (!raw) return control(channel.label, bytes); // control message
          heard();
          captionsSeen += 1;
          // Once v2 is flowing, the old channel only repeats it.
          if (!sawV2) emitCaption(raw);
          else canonicalId(raw);
        }
      } catch (err) {
        note(`${channel.label} parse failed`, String(err));
        if (bytes) rejected(channel.label, bytes);
      }
    });
  }

  // A caption arrived: the silence watchdogs start over. Control packets don't count.
  function heard() {
    lastPacketAt = Date.now();
    resendWatch.packet();
    reopenWatch.packet();
  }

  // Counted, never an alarm by themselves: Meet sends these in a quiet room
  // too. If Meet moves the caption field again, captions will look like this,
  // and "people talking, control packets only" is what gives it away.
  function control(label, bytes) {
    controlPackets += 1;
    controlSamples.push({ label, length: bytes.length, head: Array.from(bytes.subarray(0, 48)).join(",") });
    if (controlSamples.length > 5) controlSamples.shift();
  }

  function rejected(label, bytes) {
    packetsRejected += 1;
    if (rejectedSamples.length < 5) rejectedSamples.push({ label, length: bytes.length, head: Array.from(bytes.subarray(0, 48)).join(",") });
  }

  // A caption channel, whoever opened it: Meet (when you press CC), Meet's
  // server, or us. Listen on it, and tell Meet the language again once it's open.
  let lastLanguageResend = 0;
  function adoptCaptionChannel(channel, pc) {
    if (wiredChannels.has(channel)) return;
    wireCaptionChannel(channel);
    currentChannel.set(channel.label, { channel, pc });
    const now = Date.now();
    if (desiredLanguage && now - lastLanguageResend >= 2000) {
      lastLanguageResend = now;
      whenOpen(channel, () => resendLanguage("new caption channel"));
    }
    watchForDrop(channel, pc);
  }

  // Meet's server sometimes closes a caption channel mid-call. Open it again
  // while the call goes on (Meet's own captions_v2 is left to Meet).
  function watchForDrop(channel, pc) {
    const check = () => {
      if (channel.readyState !== "closing" && channel.readyState !== "closed") return void setTimeout(check, 1000);
      if (isClosed(pc)) return;
      if (currentChannel.get(channel.label)?.channel !== channel) return;
      if (channel.label === "captions_v2" && !ownChannels.has(channel)) return;
      note("caption channel dropped, reopening", channel.label);
      reopen(channel.label, pc, 0);
    };
    setTimeout(check, 1000);
  }

  function reopen(label, pc, tries) {
    try {
      openOwn(pc, label);
      note("caption channel reopened", label);
    } catch (err) {
      note(`could not reopen ${label}`, String(err));
      if (tries >= 5) return;
      setTimeout(() => {
        const latest = meetingConnection;
        if (!isClosed(latest)) reopen(label, latest, tries + 1);
      }, 5000);
    }
  }

  // Opening "captions" and "captions_v2" ourselves is what asks Meet's server
  // for captions. If Meet already opened its own captions_v2 on this call, we
  // listen on that one instead of opening a rival. A clashing id moves on to
  // the next one.
  function openOwn(pc, label) {
    if (label === "captions_v2" && meetOwnsV2.has(pc)) return null;
    let lastErr;
    for (let i = 0; i < 20; i++) {
      creatingOwn = true;
      try {
        return pc.createDataChannel(label, { ordered: true, maxRetransmits: 10, id: ++channelIds });
      } catch (err) {
        lastErr = err;
        if (err?.name !== "OperationError") break;
      } finally {
        creatingOwn = false;
      }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------- peer connection

  let meetingConnection = null;
  let mediaSession = null;
  let mediaSessionOrigin = null;
  let lastOutgoingOp = 0;
  let lastOutgoingAck = 0;
  let joined = false;
  let joinedAt = 0;
  let captionsRequestedAt = 0;

  function onJoined(pc) {
    meetingConnection = pc;
    if (joined) return;
    joined = true;
    joinedAt = Date.now();
    emit("store-found", { via: "meet-collections", hasCaptions: true, href: location.href });
    emit("join-status", { status: "joined" });
    reportTitle();
    reportHealth();
  }

  function onLeft(why) {
    note("meeting connection ended", why);
    joined = false;
    joinedAt = 0;
    meetingConnection = null;
    captionsRequestedAt = 0;
    stopWatchdog();
    emit("join-status", { status: "left" });
  }

  // Every data channel, opened by either side, goes through here.
  function onChannel(pc, channel, origin) {
    if (!channel) return;
    noteChannel(channel, origin);
    const label = channel.label;
    if (origin === "earshot") ownChannels.add(channel);
    if (label === "collections" && origin === "remote") {
      onJoined(pc);
      channel.addEventListener("message", async (e) => {
        const bytes = await unwrap(e.data).catch(() => null);
        const device = bytes && deviceFromCollections(bytes);
        if (device) addDevices([device]);
      });
    } else if (label === "media-session") {
      adoptMediaSession(channel, origin);
    } else if (CAPTION_LABELS.includes(label)) {
      if (label === "captions_v2" && origin === "meet") meetOwnsV2.add(pc);
      if (origin !== "earshot") onJoined(pc);
      adoptCaptionChannel(channel, pc);
    } else if (label === "p2p") {
      onPeerToPeer(channel);
    }
  }

  function watchConnection(pc) {
    pc.addEventListener("datachannel", (event) => onChannel(pc, event.channel, "remote"));
    pc.addEventListener("connectionstatechange", () => {
      if (pc === meetingConnection && (pc.connectionState === "closed" || pc.connectionState === "failed")) onLeft(pc.connectionState);
    });
  }

  // Meet closes the call's connection itself when you leave, and close()
  // fires no event, so check the connection's state every couple of seconds.
  setInterval(() => {
    if (joined && isClosed(meetingConnection)) onLeft(meetingConnection?.connectionState ?? "gone");
  }, 2000);

  const NativePC = window.RTCPeerConnection;
  if (NativePC) {
    const WatchedPC = function (...args) {
      const pc = new NativePC(...args);
      try {
        watchConnection(pc);
      } catch (err) {
        note("could not watch connection", String(err));
      }
      return pc;
    };
    WatchedPC.prototype = NativePC.prototype;
    Object.setPrototypeOf(WatchedPC, NativePC);
    window.RTCPeerConnection = WatchedPC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = WatchedPC;

    // Channels Meet opens itself never fire "datachannel" on this side, so
    // catch them as they're made. Meet opens media-session (and captions_v2
    // when you press CC) this way.
    const nativeCreate = NativePC.prototype.createDataChannel;
    if (nativeCreate) {
      NativePC.prototype.createDataChannel = function () {
        const own = creatingOwn;
        const channel = nativeCreate.apply(this, arguments);
        try {
          onChannel(this, channel, own ? "earshot" : "meet");
        } catch (err) {
          note("could not watch new channel", String(err));
        }
        return channel;
      };
    }
  }

  // Watch Meet's own media-session messages to learn the sequence numbers a
  // caption-language request has to follow.
  const nativeSend = window.RTCDataChannel?.prototype.send;
  if (nativeSend) {
    window.RTCDataChannel.prototype.send = function (data) {
      if (this.label === "media-session") {
        try {
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
          const fields = readMessage(bytes);
          const op = first(path(fields, 1, 2), 1);
          if (typeof op === "number") lastOutgoingOp = Math.max(lastOutgoingOp, op);
          const ack = first(path(fields, 1, 1), 2);
          if (typeof ack === "number") lastOutgoingAck = Math.max(lastOutgoingAck, ack);
        } catch {}
      }
      return nativeSend.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------- caption language

  // Meet's server only sends captions in the language the client asked for,
  // over media-session. A new media-session restarts Meet's numbering.
  let desiredLanguage = null; // Meet's code, e.g. "en-US"
  let reassertLanguage = false; // send the language as soon as a media-session is open
  let configSeq = 0;
  let pendingAck = null;
  let language = { code: null, result: null, at: null, sent: 0 };

  function adoptMediaSession(channel, origin) {
    if (mediaSession === channel) return;
    mediaSession = channel;
    mediaSessionOrigin = origin;
    lastOutgoingOp = 0;
    lastOutgoingAck = 0;
    configSeq = 0;
    pendingAck?.("unavailable");
    channel.addEventListener("message", async (e) => {
      const bytes = await unwrap(e.data).catch(() => null);
      if (bytes) onMediaSessionMessage(bytes);
    });
    whenOpen(channel, () => {
      if (reassertLanguage && mediaSession === channel && desiredLanguage) {
        reassertLanguage = false;
        sendLanguage(desiredLanguage, { waitForAck: false });
      }
    });
  }

  // Meet answers a caption-config update with a larger message carrying a
  // config number: higher than the last one means it took the change.
  function onMediaSessionMessage(bytes) {
    if (bytes.byteLength <= 100) return;
    let seq;
    try {
      seq = first(path(readMessage(bytes), 1, 4), 1);
    } catch {}
    if (typeof seq !== "number") return pendingAck?.("accepted");
    if (seq > configSeq) {
      configSeq = seq;
      pendingAck?.("accepted");
    } else pendingAck?.("rejected");
  }

  function sendLanguage(code, { waitForAck = true } = {}) {
    const ms = mediaSession;
    if (!code || !ms || ms.readyState !== "open") return Promise.resolve("unavailable");
    const op = lastOutgoingOp + 1;
    const ack = lastOutgoingAck + 1;
    const update = encode([[1, [[2, [[1, op], [3, [[1, [[9, [[1, code], [2, code]]]]], [2, [[1, "client_config.caption_config"]]]]]]]]]]);
    const ackPacket = (seq) => encode([[1, [[1, [[2, seq], [3, 1]]]]]]);
    let answer = Promise.resolve("sent");
    if (waitForAck) {
      pendingAck?.("superseded");
      answer = new Promise((resolve) => {
        const done = (result) => {
          clearTimeout(timer);
          if (pendingAck === done) pendingAck = null;
          resolve(result);
        };
        const timer = setTimeout(() => done("timeout"), 5000);
        pendingAck = done;
      });
    }
    try {
      ms.send(update);
      ms.send(ackPacket(ack));
      ms.send(ackPacket(ack + 1));
    } catch (err) {
      note("language request failed", String(err));
      pendingAck?.("unavailable");
      return Promise.resolve("unavailable");
    }
    language = { code, result: "sent", at: new Date().toISOString(), sent: language.sent + 1 };
    emit("caption-language", { language: code });
    return answer.then((result) => {
      if (language.code === code) language.result = result;
      if (result !== "sent") note("caption language answer", { code, result });
      return result;
    });
  }

  // No answer, or no media-session yet: say it again now and again when the
  // next media-session opens.
  function insist(result) {
    if (result !== "timeout" && result !== "unavailable") return;
    reassertLanguage = true;
    if (mediaSession?.readyState === "open") sendLanguage(desiredLanguage, { waitForAck: false });
  }

  function resendLanguage(why) {
    if (!desiredLanguage) return;
    note("sending caption language again", why);
    sendLanguage(desiredLanguage, { waitForAck: false }).then((r) => r === "unavailable" && insist(r));
  }

  async function setLanguage(lang) {
    const code = lang?.meet;
    if (!code) return emit("language-result", { ok: false });
    desiredLanguage = code;
    const result = await sendLanguage(code);
    emit("language-result", { ok: result !== "unavailable" && result !== "rejected" });
    insist(result);
  }

  // ---------------------------------------------------------------- asking for captions

  async function enableCaptions(cmd) {
    if (cmd.language?.meet) desiredLanguage = cmd.language.meet;
    const began = Date.now();
    while (!meetingConnection && Date.now() - began < 20000) await sleep(250);
    const pc = meetingConnection;
    if (!pc) {
      emit("captions-request", { ok: false, hint: "Couldn't reach Meet's caption service. Try turning captions on in Meet (CC)." });
      return;
    }
    captionsRequestedAt = Date.now();
    for (const label of CAPTION_LABELS) {
      // Asking again (the panel's Try again) mustn't open a second copy of a live channel.
      const prev = currentChannel.get(label);
      if (prev && prev.pc === pc && ["open", "connecting"].includes(prev.channel.readyState)) continue;
      try {
        openOwn(pc, label);
      } catch (err) {
        note(`could not open ${label}`, String(err));
      }
    }
    emit("captions-request", { ok: true });
    startWatchdog();
    if (desiredLanguage) sendLanguage(desiredLanguage).then(insist);
    setTimeout(() => {
      if (pc !== meetingConnection || captionsSeen) return;
      const live = CAPTION_LABELS.some((l) => {
        const c = currentChannel.get(l);
        return c && c.pc === pc && !["closing", "closed"].includes(c.channel.readyState);
      });
      if (!live) {
        note("no caption channel after 5 s");
        emit("captions-request", { ok: false, hint: "Couldn't open Meet's caption channel. Turn captions on in Meet (CC)." });
      }
    }, 5000);
  }

  // ---------------------------------------------------------------- silence recovery

  // When people are talking but no captions come, ask again: first the
  // language (after 5 s), then fresh caption channels (after a minute).
  // "Talking" comes from the call's audio levels.
  let speakingAt = 0;
  const lastEnergy = new Map(); // stats id -> { energy, duration }

  async function measureSpeech(pc) {
    try {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.kind !== "audio" || (r.type !== "inbound-rtp" && r.type !== "media-source")) return;
        const energy = r.totalAudioEnergy || 0;
        const duration = r.totalSamplesDuration || 0;
        const prev = lastEnergy.get(r.id);
        lastEnergy.set(r.id, { energy, duration });
        if (prev && duration > prev.duration && (energy - prev.energy) / (duration - prev.duration) > 1e-4) speakingAt = Date.now();
      });
    } catch {}
  }

  function makeWatchdog({ silenceMs, speakingMs, maxAttempts, maxPerMeeting, recover }) {
    let attempts = 0;
    let total = 0;
    let lastAction = 0;
    return {
      packet: () => (attempts = 0),
      reset: () => (attempts = total = lastAction = 0),
      tick(now) {
        const quietSince = Math.max(lastPacketAt, captionsRequestedAt);
        if (now - Math.max(quietSince, lastAction) < silenceMs || now - speakingAt > speakingMs) return;
        if (attempts >= maxAttempts || total >= maxPerMeeting) return;
        attempts += 1;
        total += 1;
        lastAction = now;
        recover(now - quietSince, attempts);
      },
      get total() {
        return total;
      },
    };
  }

  const resendWatch = makeWatchdog({
    silenceMs: 5000,
    speakingMs: 5000,
    maxAttempts: 2,
    maxPerMeeting: 50,
    recover: (silent) => resendLanguage(`no captions for ${Math.round(silent / 1000)} s while people talk`),
  });
  const reopenWatch = makeWatchdog({
    silenceMs: 60000,
    speakingMs: 30000,
    maxAttempts: 3,
    maxPerMeeting: 10,
    recover: (silent, attempt) => {
      const pc = meetingConnection;
      if (!pc || pc.connectionState !== "connected") return note("caption recovery skipped", pc?.connectionState ?? "no connection");
      note("no captions while people talk, opening fresh caption channels", { silentSeconds: Math.round(silent / 1000), attempt });
      for (const label of CAPTION_LABELS) {
        try {
          openOwn(pc, label);
        } catch (err) {
          note(`could not reopen ${label}`, String(err));
        }
      }
    },
  });

  let watchdog = null;
  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(async () => {
      const pc = meetingConnection;
      if (!joined || !pc || !captionsRequestedAt) return;
      await measureSpeech(pc);
      const now = Date.now();
      resendWatch.tick(now);
      reopenWatch.tick(now);
    }, 2500);
  }
  function stopWatchdog() {
    clearInterval(watchdog);
    watchdog = null;
    resendWatch.reset();
    reopenWatch.reset();
  }

  // Small calls move to a direct peer-to-peer link; Meet then needs the
  // caption language again, so it's resent 3 s and 8 s after the switch.
  let p2pResponses = 0;
  let lastP2p = 0;
  function onPeerToPeer(channel) {
    note("Meet started a peer-to-peer link", channel.readyState);
    whenOpen(channel, () => {
      const now = Date.now();
      if (now - lastP2p < 60000 || p2pResponses >= 5) return;
      lastP2p = now;
      p2pResponses += 1;
      for (const ms of [3000, 8000]) setTimeout(() => resendLanguage("peer-to-peer"), ms);
    });
  }

  // ---------------------------------------------------------------- participant list over HTTP

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    const isSync = url.includes(SYNC_COLLECTIONS);
    if (isSync && init?.body) {
      try {
        const body = typeof init.body === "string" ? init.body : textDecoder.decode(init.body);
        const m = /spaces\/[A-Za-z0-9_-]+\/devices\/[A-Za-z0-9_-]+/.exec(body);
        if (m && !selfDevice) {
          selfDevice = m[0];
          note("found own device", selfDevice);
        }
      } catch {}
    }
    const result = nativeFetch.apply(this, arguments);
    if (isSync) {
      result
        .then((res) => res.clone().text())
        .then((b64) => {
          const bytes = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
          const devices = devicesFromSync(bytes);
          if (devices.length) addDevices(devices);
        })
        .catch((err) => note("participant sync parse failed", String(err)));
    }
    return result;
  };

  // ---------------------------------------------------------------- title

  function reportTitle() {
    const title =
      document.querySelector("[data-meeting-title]")?.getAttribute("data-meeting-title") ||
      document.title.replace(/^Meet\s*[-–]\s*/, "").trim();
    const meetingRef = currentRef();
    if (title && title !== meetingRef && !/^Meet$|^Google Meet$/i.test(title)) emit("title", { title });
    else if (meetingRef) emit("title", { title: meetingRef, fallback: true });
  }

  // ---------------------------------------------------------------- health

  // How capture is going, sent when the call starts and every 15 s after, so
  // the panel can say what is wrong instead of looking live. `recent` counts
  // since the last report.
  const HEALTH_EVERY_MS = 15000;
  const reported = { accepted: 0, rejected: 0, control: 0 };

  function reportHealth(extra = {}) {
    const now = Date.now();
    const recent = { accepted: captionsSeen - reported.accepted, rejected: packetsRejected - reported.rejected, control: controlPackets - reported.control };
    Object.assign(reported, { accepted: captionsSeen, rejected: packetsRejected, control: controlPackets });
    const quietSince = Math.max(lastPacketAt, joinedAt, captionsRequestedAt);
    emit("health", {
      late,
      joined,
      attached: currentChannel.size > 0,
      accepted: captionsSeen,
      rejected: packetsRejected,
      control: controlPackets,
      recent,
      quietMs: quietSince ? now - quietSince : null,
      hearsSpeech: true,
      speechAgoMs: speakingAt ? now - speakingAt : null,
      ...extra,
    });
  }

  // A call is on the page when Meet is playing someone's audio.
  function callOnPage() {
    try {
      return [...document.querySelectorAll("audio")].some((a) => a.srcObject?.getAudioTracks?.().some((t) => t.readyState === "live"));
    } catch {
      return false;
    }
  }

  setInterval(() => {
    if (joined) reportHealth();
    else if (late && window.top === window && currentRef() && callOnPage()) reportHealth({ inCall: true });
  }, HEALTH_EVERY_MS);

  // The silence watchdog measures speech only once captions were asked for;
  // the health report needs it for the whole call.
  setInterval(() => {
    if (joined && meetingConnection && !(watchdog && captionsRequestedAt)) measureSpeech(meetingConnection);
  }, 2500);

  // ---------------------------------------------------------------- diagnostics and commands

  function diagnostics() {
    const now = Date.now();
    return {
      hook: HOOK,
      injectedLate: late,
      href: location.href,
      isTopFrame: window.top === window,
      meetingRef: currentRef(),
      peerConnectionWrapped: window.RTCPeerConnection !== NativePC,
      inMeeting: joined,
      connectionState: meetingConnection?.connectionState ?? null,
      mediaSessionState: mediaSession?.readyState ?? null,
      mediaSessionOrigin,
      lastOutgoingOp,
      lastOutgoingAck,
      desiredLanguage,
      language,
      participantsKnown: names.size,
      selfDevice,
      selfName: selfDevice ? names.get(selfDevice) ?? null : null,
      captionsRequestedAgoMs: captionsRequestedAt ? now - captionsRequestedAt : null,
      packetsSeen,
      packetsRejected,
      rejectedSamples,
      controlPackets,
      controlSamples,
      lastPacketAgoMs: lastPacketAt ? now - lastPacketAt : null,
      speakingAgoMs: speakingAt ? now - speakingAt : null,
      recoveries: { languageResends: resendWatch.total, channelReopens: reopenWatch.total, peerToPeer: p2pResponses },
      captionsSeen,
      captionsV2Seen: sawV2,
      channels: channelsSeen.map((c) => ({ label: c.label, origin: c.origin, id: c.id, at: c.at, state: c.channel.readyState })),
      log,
    };
  }

  document.documentElement.addEventListener(IN, (event) => {
    let cmd;
    try {
      cmd = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (cmd.type === "diagnostics") emit("diagnostics", { data: diagnostics() });
    else if (cmd.type === "enable-captions") enableCaptions(cmd);
    else if (cmd.type === "set-language") setLanguage(cmd.language);
    else if (cmd.type === "resync" && joined) {
      // A bridge that arrived mid-call (Earshot reloaded) missed the join.
      emit("store-found", { via: "meet-collections", hasCaptions: true, href: location.href });
      emit("join-status", { status: "joined" });
      reportTitle();
      reportHealth();
    }
  });
})();
