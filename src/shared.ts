import { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import fsP from "node:fs/promises"
import fs from "node:fs";
import { ensureDirSync } from "fs-extra";

// ----
// REPO
// ----

let repo: Repo | null = null;
export function getRepo(): Repo {
  if (repo === null) {
    repo = new Repo({
      network: [
        new BrowserWebSocketClientAdapter(
          process.env.AM_REPO || "wss://sync.automerge.org"
        ),
      ],
    });
  }
  return repo;
}

// ---------
// LOCATIONS
// ---------

export type Location = LocationAutomerge | LocationFile | LocationPipe;
export type LocationAutomerge = {
  type: "automerge";
  docUrl: AutomergeUrl;
  path: string[];
};
export type LocationFile = { type: "file"; path: string };
export type LocationPipe = { type: "pipe" }; // can mean stdin or stdout, depending on position
export type AMFSFile = { contentType: string; contents: string | Uint8Array };
export type AMFSDirectory = {
  [name: string]: AMFSDirectory | AMFSFile;
};

export type ValueType = "fs" | "raw" | "json";

export function parseLocation(s: string): Location {
  if (s === "-") {
    return { type: "pipe" };
  } else if (s.startsWith("automerge:")) {
    const [docUrl, ...path] = s.split("/");
    return { type: "automerge", docUrl: docUrl as AutomergeUrl, path };
  } else {
    return { type: "file", path: s };
  }
}

export function stringifyLocation(l: Location): string {
  if (l.type === "automerge") {
    return [l.docUrl, ...l.path].join("/");
  } else if (l.type === "file") {
    return l.path;
  } else {
    return l.type;
  }
}

export function getAtPath(doc: unknown, path: string[]): unknown {
  let value: any = doc;
  for (const key of path) {
    value = value[key];
  }
  return value;
}

export function setAtPath(doc: unknown, path: string[], value: unknown) {
  let doclet: any = doc;
  for (const key of path.slice(0, -1)) {
    doclet = doclet[key];
  }
  doclet[path[path.length - 1]] = value;
}

// AM -> FS, not raw
//   AM path can lead to any value, write it out as JSON
//   writeToLocation gets FS, a value, raw = false
// AM -> FS, raw
//   AM path must lead to string, write it out raw
//   writeToLocation gets FS, a string, raw = true
// FS -> AM, not raw
//   FS path must be json-parseable, AM path must be compatible with parsed val, write it out as parsed val
//   writeToLocation gets AM, a value, raw = false
// FS -> AM, raw
//   FS path can lead to any contents, AM path must not be root, write it out as string val
//   writeToLocation gets AM, a string, raw = true
// AM -> AM, not raw
//   AM src path can lead to any value, AM dst path must be compatible
//   writeToLocation gets AM, a value, raw = true
// AM -> AM, raw
//   not allowed?

// so AM locations ignore json

function replacer(key: string, value: any) {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  } else {
    return value;
  }
}

export async function writeToLocation(
  dst: Location,
  val: unknown,
  type: ValueType
) {
  if (type === "fs") {
    if (dst.type !== "file") {
      throw new AMTError(`value type "fs" can be only written to file system`);
    }

    if (!isAMFS(val)) {
      throw new AMTError(
        "value must be an automerge file object to copy in fs mode"
      );
    }

    writeAMFS(val, dst.path);
  } else if (dst.type === "file" || dst.type === "pipe") {
    let stringVal: string | Uint8Array;

    if (type === "raw") {
      if (typeof val !== "string" && !(val instanceof Uint8Array)) {
        throw new AMTError(
          "value must be a string or bytes to copy in raw mode"
        );
        // throw new AMTError(`value at ${stringifyLocation(src)} is not a string`);
      }
      stringVal = val;
    } else {
      stringVal =
        JSON.stringify(val, replacer, dst.type === "pipe" ? undefined : 2) +
        "\n";
    }

    if (dst.type === "pipe") {
      process.stdout.write(stringVal);
    } else {
      fsP.writeFile(dst.path, stringVal);
    }
  } else if (dst.type === "automerge") {
    const repo = getRepo();
    const handle = repo.find(dst.docUrl);
    await handle.doc();
    handle.change((doc: any) => {
      if (dst.path.length === 0) {
        // TODO: special case for no path?
        if (!(typeof val === "object" && val !== null)) {
          throw new AMTError(
            "only an object can be written to a document root"
          );
        }
        for (const key in val) {
          doc[key] = (val as any)[key];
        }
      } else {
        let doclet = doc;
        for (const key of dst.path.slice(0, -1)) {
          doclet = doclet[key];
        }
        doclet[dst.path[dst.path.length - 1]] = val;
      }
    });
  }
}

function writeAMFS(directoryOrFile: AMFSDirectory | AMFSFile, path: string) {
  if (isAMFSFile(directoryOrFile)) {
    const contents = directoryOrFile.contents;
    fs.writeFileSync(path, contents);
  } else {
    ensureDirSync(path);

    Object.entries(directoryOrFile).forEach(([name, node]) => {
      writeAMFS(node, `${path}/${name}`);
    });
  }
}

function isAMFS(node: unknown): node is AMFSFile | AMFSDirectory {
  return isAMFSFile(node) || isAMFSDirectory(node);
}

function isAMFSFile(node: unknown): node is AMFSFile {
  return (
    !!node &&
    typeof node === "object" &&
    "contentType" in node &&
    "contents" in node &&
    typeof node.contentType === "string" &&
    (typeof node.contents === "string" || node.contents instanceof Uint8Array)
  );
}

function isAMFSDirectory(node: unknown): node is AMFSDirectory {
  return (
    !!node && typeof node === "object" && Object.values(node).every(isAMFS)
  );
}


// ------
// ERRORS
// ------

export class AMTError extends Error { }

export async function catchAMTErrors(f: () => Promise<void>, fatal: boolean = true) {
  try {
    await f();
  } catch (e) {
    if (e instanceof AMTError) {
      console.error("error: " + e.message);
      if (fatal) {
        process.exit(1);
      }
    } else {
      throw e;
    }
  }
}


// ----
// MISC
// ----

export async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertNever(never: never, message?: string): never {
  throw new Error(message || `Reached unreachable code: unexpected value ${never}`);
}
