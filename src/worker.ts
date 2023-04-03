import { Sharer } from "./sharer";
import { WASI, PreopenDirectory, Fd, File } from "@bjorn3/browser_wasi_shim/dist";
import { Iovec } from "@bjorn3/browser_wasi_shim/typings/wasi_defs";
// @ts-ignore
import zlsWasm from "url:./zls.wasm";

let sharer: Sharer = new Sharer();

enum StdioKind {
    stdin = "stdin",
    stdout = "stdout",
    stderr = "stderr",
}

class Stdio extends Fd {
    kind: StdioKind;
    buffer: number[];

    constructor(kind: StdioKind) {
        super();
        this.kind = kind;
        this.buffer = [];
    }

    fd_write(view8: Uint8Array, iovs: Iovec[]): { ret: number; nwritten: number; } {
        let nwritten = 0;
        for (let iovec of iovs) {
            const slice = view8.slice(iovec.buf, iovec.buf + iovec.buf_len);

            if (this.kind == StdioKind.stdin) {
                throw new Error("Cannot write to stdin");
            } else if (this.kind == StdioKind.stdout) {
                this.buffer = this.buffer.concat(Array.from(slice));
                
                while (true) {
                    const data = new TextDecoder("utf-8").decode(Uint8Array.from(this.buffer));

                    if (!data.startsWith("Content-Length: ")) break;
                    
                    const len = parseInt(data.slice("Content-Length: ".length));
                    const bodyStart = data.indexOf("\r\n\r\n") + 4;

                    if (bodyStart === -1) break;
                    if (this.buffer.length < bodyStart + len) break;
                    
                    this.buffer.splice(0, bodyStart + len);
                    postMessage(JSON.parse(data.slice(bodyStart, bodyStart + len)));
                }
            } else {
                this.buffer.push(...slice);

                while (this.buffer.indexOf(10) !== -1) {
                    let data = new TextDecoder("utf-8").decode(Uint8Array.from(this.buffer.splice(0, this.buffer.indexOf(10) + 1)));
                    console.debug(this.kind, data);
                }
            }

            nwritten += iovec.buf_len;
        }
        return { ret: 0, nwritten };
    }

    fd_read(view8: Uint8Array, iovs: Iovec[]): { ret: number; nread: number; } {
        if (this.kind != StdioKind.stdin) throw new Error("Cannot read from non-stdin");

        let nread = 0;
        if (sharer.index === 0) {
            Atomics.store(new Int32Array(sharer.stdinBlockBuffer), 0, 0);
            Atomics.wait(new Int32Array(sharer.stdinBlockBuffer), 0, 0);
        }

        sharer.lock();

        console.log(sharer.index);

        for (let iovec of iovs) {
            const read = Math.min(iovec.buf_len, sharer.index);
            const sl = new Uint8Array(sharer.dataBuffer).slice(0, read);

            console.log("stdin", sharer.index, read, new TextDecoder("utf-8").decode(sl))

            view8.set(sl, iovec.buf);
            new Uint8Array(sharer.dataBuffer).set(new Uint8Array(sharer.dataBuffer, read), 0);

            sharer.index -= read;
            
            nread += read;
        }

        sharer.unlock();

        return { ret: 0, nread };
    }
}

const stdin = new Stdio(StdioKind.stdin);

onmessage = (event) => {
    console.log("SABs", event.data);

    sharer.indexBuffer = event.data.indexBuffer;
    sharer.lockBuffer = event.data.lockBuffer;
    sharer.stdinBlockBuffer = event.data.stdinBlockBuffer;
    sharer.dataBuffer = event.data.dataBuffer;
};

(async () => {
    const wasmResp = await fetch(zlsWasm);
    const wasmData = await wasmResp.arrayBuffer();

    console.log("wasm len", wasmData.byteLength);

    let args = ["zls.wasm"];
    let env = [];
    let fds = [
        stdin, // stdin
        new Stdio(StdioKind.stdout), // stdout
        new Stdio(StdioKind.stderr), // stderr
        new PreopenDirectory(".", {
            "zls.wasm": new File(wasmData),
        }),
    ];
    let wasi = new WASI(args, env, fds);

    let wasm = await WebAssembly.compile(wasmData);
    let inst = await WebAssembly.instantiate(wasm, {
        "wasi_snapshot_preview1": wasi.wasiImport,
    });  
    wasi.start(inst);
})();
