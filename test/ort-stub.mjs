/**
 * Minimal stand-in for `onnxruntime-web`'s Node entry, used by
 * test/recall-embed.test.ts.
 *
 * It implements exactly the surface src/recall/embed.ts touches (`env`,
 * `Tensor`, `InferenceSession`) and returns, per row, a 4-wide "hidden state"
 * whose values encode what the caller actually passed in:
 *
 *   [0] sum of the input ids at MASKED positions
 *   [1] number of masked positions (the real sequence length)
 *   [2] 0
 *   [3] 0
 *
 * Written at position 0 so the embedder's CLS pooling picks it up. The padded
 * width is deliberately NOT encoded in the vector — a real masked-attention model
 * cannot see its pads either — and is recorded separately in `__widths`, so
 * right-padding is still observable without making the embedding depend on the
 * batch.
 */

export const env = { wasm: {}, logLevel: '' };
export const __batches = [];
export const __widths = [];
export const __threads = [];

export class Tensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

export class InferenceSession {
  static async create(model, options) {
    return new InferenceSession(model, options);
  }

  constructor(model, options) {
    this.modelBytes = model?.byteLength ?? model?.length ?? 0;
    this.options = options;
  }

  async run(feeds) {
    const ids = feeds.input_ids;
    const mask = feeds.attention_mask;
    const [rows, width] = ids.dims;
    __batches.push(rows);
    __widths.push(width);
    const dim = 4;
    const out = new Float32Array(rows * width * dim);
    for (let row = 0; row < rows; row++) {
      let sum = 0;
      let count = 0;
      for (let column = 0; column < width; column++) {
        if (Number(mask.data[row * width + column]) === 0) continue;
        sum += Number(ids.data[row * width + column]);
        count += 1;
      }
      out[row * width * dim + 0] = sum;
      out[row * width * dim + 1] = count;
    }
    return { last_hidden_state: new Tensor('float32', out, [rows, width, dim]) };
  }

  async release() {}
}

// `ort.env.wasm.numThreads = n` is a plain property write; record it so a test can
// prove the configured value (not Node's default of 4) is what actually applies.
const wasm = new Proxy(
  {},
  {
    set(target, key, value) {
      if (key === 'numThreads') __threads.push(value);
      target[key] = value;
      return true;
    },
  },
);
env.wasm = wasm;
