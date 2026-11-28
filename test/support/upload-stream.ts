// Zero queueing makes producer reads observable independently of transport buffering.
export function filledStream(size: number, onPull = () => {}, onCancel = () => {}): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream({
        pull(controller) {
            onPull();
            if (offset === size) {
                controller.close();
                return;
            }
            const length = Math.min(256 * 1024, size - offset);
            controller.enqueue(new Uint8Array(length).fill(97));
            offset += length;
        },
        cancel: onCancel,
    }, { highWaterMark: 0 });
}
