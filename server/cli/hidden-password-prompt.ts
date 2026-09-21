import { timingSafeEqual } from "node:crypto";

type TtyInput = NodeJS.ReadStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
};

export async function promptHiddenConfirmedPassword(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<string> {
  const first = await readHiddenLine(input, output, "Password: ");
  const second = await readHiddenLine(input, output, "Confirm password: ");

  if (!utf8Equal(first, second)) {
    throw new Error("Password confirmation does not match");
  }
  return first;
}

function readHiddenLine(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  prompt: string,
): Promise<string> {
  const tty = input as TtyInput;
  if (tty.isTTY !== true || typeof tty.setRawMode !== "function") {
    throw new Error("Password prompt requires an interactive TTY");
  }

  const previousRawMode = tty.isRaw === true;
  const previousDataListeners = input.listeners("data").filter(
    (listener): listener is (chunk: Buffer | string) => void => typeof listener === "function",
  );
  let restored = false;
  let value = "";

  const restore = () => {
    if (restored) return;
    restored = true;
    input.removeListener("data", onData);
    input.removeListener("error", onError);
    input.removeListener("end", onTerminalInput);
    input.removeListener("close", onTerminalInput);
    input.removeAllListeners("data");
    for (const listener of previousDataListeners) {
      input.on("data", listener);
    }
    tty.setRawMode?.(previousRawMode);
  };

  const fail = (reject: (error: Error) => void, error: Error) => {
    restore();
    reject(error);
  };

  const finish = (resolve: (password: string) => void) => {
    output.write("\n");
    restore();
    resolve(value);
  };

  let resolveLine: (password: string) => void = () => undefined;
  let rejectLine: (error: Error) => void = () => undefined;

  const onError = () => {
    fail(rejectLine, new Error("Password prompt failed"));
  };

  const onTerminalInput = () => {
    fail(rejectLine, new Error("Password prompt failed"));
  };

  const onData = (chunk: Buffer | string) => {
    for (const character of chunk.toString()) {
      if (character === "\u0003") {
        fail(rejectLine, new Error("Password prompt cancelled"));
        return;
      }
      if (character === "\u0004") {
        onTerminalInput();
        return;
      }
      if (character === "\r" || character === "\n") {
        finish(resolveLine);
        return;
      }
      if (character === "\u0008" || character === "\u007f") {
        value = Array.from(value).slice(0, -1).join("");
        continue;
      }
      if (character >= " ") {
        value += character;
      }
    }
  };

  return new Promise<string>((resolve, reject) => {
    resolveLine = resolve;
    rejectLine = reject;
    input.removeAllListeners("data");
    input.on("data", onData);
    input.once("error", onError);
    input.once("end", onTerminalInput);
    input.once("close", onTerminalInput);
    try {
      output.write(prompt);
      tty.setRawMode?.(true);
      input.resume();
    } catch {
      fail(reject, new Error("Password prompt failed"));
    }
  });
}

function utf8Equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const sameLength = leftBytes.length === rightBytes.length;
  const comparisonBytes = sameLength ? rightBytes : Buffer.alloc(leftBytes.length);
  const equal = timingSafeEqual(leftBytes, comparisonBytes);
  return sameLength && equal;
}
