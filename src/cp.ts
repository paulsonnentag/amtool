import * as cmd from "cmd-ts";
import rlP from "node:readline/promises";
import {
  AMTError,
  Location,
  LocationAutomerge,
  LocationFile,
  ValueType as ValueType,
  assertNever,
  catchAMTErrors,
  getAtPath,
  getRepo,
  parseLocation,
  stringifyLocation,
  wait,
  writeToLocation,
} from "./shared.js";
import chokidar from "chokidar";
import fsP from "node:fs/promises";

export const cp = cmd.command({
  name: "cp",
  description:
    "copy a value from an automerge document to a file or vice versa",
  args: {
    src: cmd.positional({
      displayName: "src",
      type: cmd.string,
      description:
        "the source location (automerge:url[/path] or a file path or - for stdin)",
    }),
    dst: cmd.positional({
      displayName: "dst",
      type: cmd.string,
      description:
        "the destination location (automerge:url[/path] or a file path or - for stdout)",
    }),
    watch: cmd.flag({
      type: cmd.boolean,
      long: "watch",
      short: "w",
      description: "watch the source for changes and update the destination",
    }),
    raw: cmd.flag({
      type: cmd.boolean,
      short: "r",
      long: "raw",
      description: "read the source as a raw string or byte array",
    }),
    fs: cmd.flag({
      type: cmd.boolean,
      short: "f",
      long: "file",
      description: "read the source as an automerge file system",
    }),
  },
  handler: async (args) => {
    const src = parseLocation(args.src);
    const dst = parseLocation(args.dst);

    if (args.raw && args.fs) {
      throw new AMTError(
        "source can either be read as raw or as an automerge file system"
      );
    }

    const type = args.raw ? "raw" : args.fs ? "fs" : "json";

    if (src.type === "automerge") {
      await cpFromAutomerge(src, dst, args.watch, type);
    } else if (src.type === "file") {
      await cpFromFile(src, dst, args.watch, type);
    } else if (src.type === "pipe") {
      await cpFromPipe(dst, args.watch, type);
    } else {
      assertNever(src);
    }
  },
});

async function cpFromAutomerge(
  src: LocationAutomerge,
  dst: Location,
  watch: boolean,
  type: ValueType
) {
  if (type === "raw" && dst.type === "automerge") {
    throw new AMTError(
      "raw copy from automerge to automerge doesn't really make sense"
    );
  }

  async function onDoc(doc: any) {
    const value = getAtPath(doc, src.path);
    await writeToLocation(dst, value, type);
    if (dst.type !== "pipe") {
      console.error(
        `wrote ${stringifyLocation(src)} to ${stringifyLocation(dst)}`
      );
    }
  }

  const repo = getRepo();
  const handle = repo.find(src.docUrl);

  if (watch) {
    handle.addListener("change", async (e) => {
      catchAMTErrors(async () => {
        await onDoc(e.doc);
      }, false);
    });
  } else {
    const doc = await handle.doc();
    if (!doc) {
      throw new AMTError(`document ${src.docUrl} not found`);
    } else {
      await onDoc(doc);
    }
    await wait(500);
    process.exit(0);
  }
}

async function cpFromFile(
  src: LocationFile,
  dst: Location,
  watch: boolean,
  type: ValueType
) {
  if (type === "fs") {
    throw new AMTError(
      `value type "fs" is not implemented yet for file source`
    );
  }

  async function onFile() {
    const contents = await fsP.readFile(src.path, "utf8");
    const value = type === "raw" ? contents : JSON.parse(contents);
    await writeToLocation(dst, value, type);
    if (dst.type !== "pipe") {
      console.error(
        `wrote ${stringifyLocation(src)} to ${stringifyLocation(dst)}`
      );
    }
  }

  if (watch) {
    chokidar.watch(src.path).on("all", () => {
      catchAMTErrors(async () => {
        await onFile();
      }, false);
    });
  } else {
    await onFile();
    await wait(500);
    process.exit(0);
  }
}

async function cpFromPipe(
  dst: Location,
  watch: boolean,
  sourceType: ValueType
) {
  if (sourceType === "fs") {
    throw new AMTError(`value type "fs" is not supported on pipe`);
  }

  async function onPipeData(contents: string) {
    const value = sourceType === "raw" ? contents : JSON.parse(contents);
    await writeToLocation(dst, value, sourceType);
    if (dst.type !== "pipe") {
      console.error(
        `wrote ${watch ? "line of stdin" : "stdin"} to ${stringifyLocation(
          dst
        )}`
      );
    }
  }

  if (watch) {
    const readInterface = rlP.createInterface(process.stdin);
    readInterface.on("line", (line) => {
      catchAMTErrors(async () => {
        await onPipeData(line);
      }, false);
    });
    readInterface.on("close", async () => {
      await wait(500);
      process.exit(0);
    });
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks).toString("utf8");
    await writeToLocation(dst, data, sourceType);
    await wait(500);
    process.exit(0);
  }
}
