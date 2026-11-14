// Voice (decision 61 A): hands the mic's samples to the page in blocks, on the audio thread. Nothing is kept here.
class CruxCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch?.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('crux-capture', CruxCapture);
