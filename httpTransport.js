// HTTP long-poll transport for agent → hub communication.
// Used as a fallback when WebSocket is unavailable.

const CHANNEL_ID_LEN = 16;

class HttpTransport {
  constructor(hubUrl, token) {
    this.hubUrl = hubUrl;
    this.token = token;
    this.active = false;
    this._running = false;
    this._onMessage = null;
    this._onClose = null;
    this._seq = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.active = true;
    this._poll();
  }

  stop() {
    this._running = false;
    this.active = false;
  }

  onMessage(cb) { this._onMessage = cb; }
  onClose(cb) { this._onClose = cb; }

  // Fire-and-forget send (JSON message)
  send(msg) {
    if (!this.active) return;
    this._post('/api/agent/push', msg).catch(() => {});
  }

  // Send binary data (PTY output).  Encodes as base64 with channelId envelope.
  sendBinary(channelId, buf) {
    if (!this.active) return;
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this._post('/api/agent/push', {
      type: 'binary',
      channelId,
      data: data.toString('base64'),
    }).catch(() => {});
  }

  async _poll() {
    while (this._running) {
      try {
        const res = await this._post('/api/agent/poll', {});
        if (!this._running) break;
        const body = await res.json();
        const msgs = body.messages || [];
        for (const msg of msgs) {
          if (!this._running) break;
          this._handle(msg);
        }
      } catch (e) {
        if (!this._running) break;
        // Brief pause before retry on error
        await this._sleep(1000);
      }
    }
    this.active = false;
    if (this._onClose) this._onClose();
  }

  _handle(msg) {
    if (msg.type === 'binary') {
      // Reconstruct binary frame: [16B channelId][payload]
      const idBuf = Buffer.alloc(CHANNEL_ID_LEN);
      idBuf.write((msg.channelId || '').padEnd(16, '\x00').slice(0, 16), 'ascii');
      const data = Buffer.from(msg.data || '', 'base64');
      const frame = Buffer.concat([idBuf, data]);
      if (this._onMessage) this._onMessage(frame, true);
    } else {
      if (this._onMessage) this._onMessage(JSON.stringify(msg), false);
    }
  }

  async _post(path, body) {
    const res = await fetch(`${this.hubUrl}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      this.stop();
      throw new Error('Unauthorized');
    }
    return res;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { HttpTransport };
