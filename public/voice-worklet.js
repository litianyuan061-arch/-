'use strict';

/**
 * 自然变声处理器（TD-PSOLA，基音同步叠加），运行在音频线程。
 *
 * 原理：人说话时声带每振动一次，就激发一次声道共鸣，形成一个"小波形"。
 *   1. 实时检测音高，在每个振动周期的峰值处打标记，把声音切成一个个小片段
 *   2. 按目标音高重新排列片段的间距：间距变小音调变高，变大音调变低
 *   3. 每个片段里保留了原本的声道共鸣，所以音色自然，不会出现"大胖子/花栗鼠"效果；
 *      需要改变性别感时，只把片段轻微压缩或拉伸（共振峰移动 5%~20%）
 *   4. 气泡音：真实的气泡音是声带松弛时不规则的低频振动，这里用不规则的稀疏间距排列片段来模拟
 * 清音（s、sh、气声等）不做变调，原样通过。
 * 会持续估计说话人自己的平均音高，自动换算出变到目标音高的倍数。
 *
 * 参数（processorOptions 或 port 消息）：
 *   targetF0 目标平均音高 Hz；formantFromMale / formantFromFemale 共振峰倍数；
 *   creak 气泡音强度（0 关闭）；initialF0 上次记住的说话人音高
 */

const SIZE = 1 << 16;
const MASK = SIZE - 1;
const MIN_F0 = 70;
const MAX_F0 = 450;

class VoiceChanger extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = (options && options.processorOptions) || {};
    this.params = {
      targetF0: opt.targetF0 || 0,
      formantFromMale: opt.formantFromMale || 1,
      formantFromFemale: opt.formantFromFemale || 1,
      creak: opt.creak || 0,
    };
    this.port.onmessage = (e) => Object.assign(this.params, e.data);

    const sr = sampleRate;
    this.hop = Math.round(sr * 0.01); // 每 10ms 检测一次音高
    this.tMax = Math.ceil(sr / MIN_F0);
    this.detHalf = this.tMax + 100; // 检测窗口半长（至少两个最长周期）
    this.dec = sr >= 32000 ? 4 : 2; // 降采样后再做自相关，省算力
    this.lhMax = Math.ceil(this.tMax / 0.8);
    this.latency = 128 + this.lhMax + this.tMax + this.detHalf + Math.ceil(this.tMax / 4) + this.hop;

    this.inBuf = new Float32Array(SIZE);
    this.outBuf = new Float32Array(SIZE);
    this.inPos = 0;
    this.outPos = -this.latency;

    this.f0s = new Float32Array(4096);
    this.nextHop = 0;
    this.marks = []; // { t, T }（T=0 表示清音）
    this.markIdx = 0;
    this.lastMark = this.detHalf;
    this.nextSyn = this.detHalf;
    this.nextFryShort = false;

    this.logF0 = Math.log(opt.initialF0 || 150);
    this.voicedCount = opt.initialF0 ? 300 : 0;
    this.ratio = 1;
    this.reportCounter = 0;

    const W = Math.floor((2 * this.detHalf) / this.dec);
    this.seg = new Float32Array(W);
    this.cum = new Float64Array(W + 1);
  }

  // 在 center 附近检测基频，返回 0 表示清音或静音
  detect(center) {
    const { dec, seg, cum, inBuf } = this;
    const start = center - this.detHalf;
    const W = seg.length;
    let energy = 0;
    for (let i = 0; i < W; i++) {
      let s = 0;
      const base = start + i * dec;
      for (let k = 0; k < dec; k++) s += inBuf[(base + k) & MASK];
      seg[i] = s / dec;
      energy += seg[i] * seg[i];
    }
    if (Math.sqrt(energy / W) < 0.004) return 0;
    cum[0] = 0;
    for (let i = 0; i < W; i++) cum[i + 1] = cum[i] + seg[i] * seg[i];
    const sr = sampleRate / dec;
    const minLag = Math.floor(sr / MAX_F0);
    const maxLag = Math.ceil(sr / MIN_F0);
    const nac = new Float32Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let r = 0;
      const n = W - lag;
      for (let i = 0; i < n; i++) r += seg[i] * seg[i + lag];
      const e = Math.sqrt(cum[n] * (cum[W] - cum[lag])) + 1e-12;
      nac[lag] = r / e;
      if (lag >= minLag && lag <= maxLag && nac[lag] > best) best = nac[lag];
    }
    if (best < 0.6) return 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const v = nac[lag];
      if (v >= 0.9 * best && v >= nac[lag - 1] && v >= nac[lag + 1]) {
        const a = nac[lag - 1];
        const c = nac[lag + 1];
        const denom = a - 2 * v + c;
        const shift = denom ? (0.5 * (a - c)) / denom : 0;
        return sr / (lag + shift);
      }
    }
    return 0;
  }

  f0At(t) {
    let h = Math.round(t / this.hop);
    if (h >= this.nextHop) h = this.nextHop - 1;
    return h < 0 ? 0 : this.f0s[h & 4095];
  }

  sample(pos) {
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.inBuf[i & MASK];
    return a + (this.inBuf[(i + 1) & MASK] - a) * f;
  }

  updatePitchTrack() {
    while (this.nextHop * this.hop + this.detHalf <= this.inPos) {
      const center = this.nextHop * this.hop;
      const f0 = center >= this.detHalf ? this.detect(center) : 0;
      this.f0s[this.nextHop & 4095] = f0;
      this.nextHop++;
      if (f0 > 0) {
        this.voicedCount++;
        const alpha = Math.max(1 / this.voicedCount, 1 / 300); // 起步快，之后约 3 秒平滑
        this.logF0 += (Math.log(f0) - this.logF0) * alpha;
      }
      const speakerF0 = Math.exp(this.logF0);
      let target = this.params.targetF0 ? this.params.targetF0 / speakerF0 : 1;
      target = Math.min(2.1, Math.max(0.5, target));
      this.ratio += (target - this.ratio) * 0.05;
      if (++this.reportCounter >= 100) {
        this.reportCounter = 0;
        this.port.postMessage({ speakerF0 });
      }
    }
  }

  // 在每个振动周期的波峰处打基音标记
  updateMarks() {
    const limit = (this.nextHop - 1) * this.hop;
    for (;;) {
      const cur = this.lastMark;
      const f0 = this.f0At(cur);
      let next;
      if (f0 > 0) {
        const T = sampleRate / f0;
        const r = Math.floor(T / 4);
        const pred = Math.round(cur + T);
        if (pred + r > limit) break;
        next = pred;
        let best = -Infinity;
        for (let i = pred - r; i <= pred + r; i++) {
          const v = this.inBuf[i & MASK];
          if (v > best) {
            best = v;
            next = i;
          }
        }
      } else {
        next = cur + this.hop;
        if (next > limit) break;
      }
      const f = this.f0At(next);
      this.marks.push({ t: next, T: f > 0 ? sampleRate / f : 0 });
      this.lastMark = next;
    }
  }

  formant() {
    const speakerF0 = Math.exp(this.logF0);
    const fem = Math.min(1, Math.max(0, (speakerF0 - 125) / 75));
    const { formantFromMale: m, formantFromFemale: f } = this.params;
    return m + (f - m) * fem;
  }

  placeGrains(until) {
    const { marks } = this;
    while (this.nextSyn <= until) {
      // 找到时间上最接近的分析标记
      while (this.markIdx + 1 < marks.length && marks[this.markIdx + 1].t <= this.nextSyn) this.markIdx++;
      if (this.markIdx + 1 >= marks.length) break; // 标记还没准备好
      const a = marks[this.markIdx];
      const b = marks[this.markIdx + 1];
      const m = this.nextSyn - a.t <= b.t - this.nextSyn ? a : b;

      let S;
      let Lh;
      let f = 1;
      let gain = 1;
      if (m.T > 0) {
        f = this.formant();
        Lh = m.T / f;
        if (this.params.creak > 0) {
          // 气泡音：低频、不规则的声门脉冲，偶尔出现"一长一短"的双脉冲
          const base = sampleRate / this.params.targetF0;
          if (this.nextFryShort) {
            S = base * (0.35 + Math.random() * 0.15);
            this.nextFryShort = false;
          } else {
            S = base * (0.9 + Math.random() * 0.7);
            this.nextFryShort = Math.random() < this.params.creak * 0.6;
          }
          Lh = Math.min(Lh, S * 0.9);
          gain = 0.75 + Math.random() * 0.5;
        } else {
          S = m.T / this.ratio;
          gain = Math.min(1, f / this.ratio);
        }
      } else {
        S = this.hop;
        Lh = this.hop;
      }

      const center = Math.round(this.nextSyn);
      const L = Math.floor(Lh);
      for (let j = -L; j <= L; j++) {
        const w = 0.5 + 0.5 * Math.cos((Math.PI * j) / Lh);
        this.outBuf[(center + j) & MASK] += this.sample(m.t + j * f) * w * gain;
      }
      this.nextSyn += S;
    }
    // 丢掉用过的旧标记
    if (this.markIdx > 64) {
      marks.splice(0, this.markIdx - 2);
      this.markIdx = 2;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const out = output[0];
    const n = out.length;

    for (let i = 0; i < n; i++) this.inBuf[(this.inPos + i) & MASK] = input ? input[i] : 0;
    this.inPos += n;

    this.updatePitchTrack();
    this.updateMarks();
    this.placeGrains(this.outPos + n + this.lhMax);

    for (let i = 0; i < n; i++) {
      const p = this.outPos + i;
      if (p < 0) {
        out[i] = 0;
        continue;
      }
      const idx = p & MASK;
      out[i] = this.outBuf[idx];
      this.outBuf[idx] = 0;
    }
    this.outPos += n;
    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}

registerProcessor('voice-changer', VoiceChanger);
