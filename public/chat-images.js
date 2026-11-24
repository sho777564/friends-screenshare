'use strict';

const FriendsChatImages = (() => {
    const limit = 4 * 1024 * 1024;
    const chunkSize = 16 * 1024;
    const timeoutMs = 90000;
    const types = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function imageType(bytes) {
        const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
        if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
        if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
        if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
        if (ascii(0, 6) === 'GIF89a' || ascii(0, 6) === 'GIF87a') return 'image/gif';
        return null;
    }

    async function prepare(blob, name) {
        if (!blob.size || blob.size > limit) throw new Error('请选择 4 MB 以内的图片。');
        const type = imageType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
        if (!type) throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片。');
        const file = new File([blob], String(name || '图片').slice(0, 120), { type });
        const url = URL.createObjectURL(file);
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            const { naturalWidth: width, naturalHeight: height } = image;
            if (!width || !height || width > 8192 || height > 8192 || width * height > 32_000_000) {
                throw new Error('图片尺寸过大，请缩小后重试。');
            }
            return { file, url, width, height };
        } catch (error) {
            URL.revokeObjectURL(url);
            if (error.name === 'EncodingError') throw new Error('图片无法打开，请换一张试试。');
            throw error;
        }
    }

    function validHeader(meta) {
        return meta && Number.isInteger(meta.size) && meta.size > 0 && meta.size <= limit
            && types.has(meta.mime) && typeof meta.name === 'string' && meta.name.length <= 120
            && typeof meta.text === 'string' && meta.text.length <= 2000 && Number.isFinite(meta.time);
    }

    function send(channel, buffer, meta, bytesPerSecond) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('图片发送超时')), timeoutMs);
            let finished = false;
            function finish(error) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                channel.close();
                if (error) reject(error);
                else resolve();
            }
            channel.onclose = () => finish(new Error('连接已断开'));
            channel.onerror = () => finish(new Error('图片连接出错'));
            channel.onmessage = event => {
                if (event.data === 'ok') finish();
                else finish(new Error('对方未接收图片'));
            };
            async function transmit() {
                channel.send(JSON.stringify(meta));
                let offset = 0;
                let nextBurst = performance.now();
                while (!finished && offset < buffer.byteLength) {
                    if (channel.bufferedAmount > 64 * 1024) {
                        await sleep(25);
                        continue;
                    }
                    const size = Math.min(chunkSize, buffer.byteLength - offset);
                    channel.send(buffer.slice(offset, offset + size));
                    offset += size;
                    nextBurst = Math.max(nextBurst, performance.now()) + size / bytesPerSecond * 1000;
                    if (offset < buffer.byteLength) await sleep(nextBurst - performance.now());
                }
            }
            const start = () => transmit().catch(finish);
            if (channel.readyState === 'open') start();
            else channel.onopen = start;
        });
    }

    function receive(channel, onImage, onClosed) {
        let metadata = null;
        let bytes = null;
        let offset = 0;
        let closed = false;
        const timer = setTimeout(close, timeoutMs);
        function close() {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            onClosed();
            channel.close();
        }
        channel.binaryType = 'arraybuffer';
        channel.onclose = close;
        channel.onerror = close;
        channel.onmessage = async event => {
            if (closed) return;
            try {
                if (!metadata) {
                    if (typeof event.data !== 'string' || event.data.length > 13000) return close();
                    metadata = JSON.parse(event.data);
                    if (!validHeader(metadata)) return close();
                    bytes = new Uint8Array(metadata.size);
                    return;
                }
                const data = event.data;
                if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > chunkSize
                    || offset + data.byteLength > bytes.length) return close();
                bytes.set(new Uint8Array(data), offset);
                offset += data.byteLength;
                if (offset !== bytes.length) return;
                if (imageType(bytes) !== metadata.mime) return close();
                const image = await prepare(new Blob([bytes], { type: metadata.mime }), metadata.name);
                if (closed) {
                    URL.revokeObjectURL(image.url);
                    return;
                }
                onImage(image, metadata);
                channel.send('ok');
                close();
            } catch {
                close();
            }
        };
    }
    return { limit, prepare, send, receive };
})();
