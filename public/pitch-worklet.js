'use strict';

/**
 * 实时变调（不改变语速）：延迟线 + 两个交替读取头，用汉宁窗交叉淡化。
 * pitch > 1 声音变高，< 1 变低。延迟约 20~40ms，适合语音聊天。
 */
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.window = Math.round(sampleRate * 0.04); // 40ms 窗口
    this.size = this.window * 4;
    this.buffer = new Float32Array(this.size);
    this.write = 0;
    this.phase = 0;
  }

  read(pos) {
    const size = this.size;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = this.buffer[((i % size) + size) % size];
    const b = this.buffer[(((i + 1) % size) + size) % size];
    return a + (b - a) * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const out = output[0];
    const ratio = parameters.pitch[0];
    const W = this.window;
    const step = (1 - ratio) / W;

    for (let n = 0; n < out.length; n++) {
      this.buffer[this.write] = input ? input[n] : 0;

      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      else if (this.phase < 0) this.phase += 1;
      const p2 = (this.phase + 0.5) % 1;

      // 两个读取头的延迟在 [1, W+1) 之间循环，相差半个窗口
      const s1 = this.read(this.write - 1 - this.phase * W);
      const s2 = this.read(this.write - 1 - p2 * W);
      const g1 = Math.sin(Math.PI * this.phase) ** 2;
      const g2 = 1 - g1; // sin² 和 cos² 相加恒为 1，音量平稳

      out[n] = s1 * g1 + s2 * g2;
      this.write = (this.write + 1) % this.size;
    }
    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifter);
