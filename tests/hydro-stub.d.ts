declare module 'crypto' {
  export function randomBytes(size: number): Buffer;
}
declare module 'child_process' {
  export function execFile(file: string, args: string[], options: any, cb: (...a: any[]) => void): any;
  export function spawnSync(file: string, args: string[], options?: any): any;
}
declare module 'fs' {
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: any, enc?: string): void;
  export function rmSync(path: string, options?: any): void;
}
declare module 'os' {
  export function tmpdir(): string;
}
declare module 'dns/promises' {
  export function lookup(host: string, options?: any): Promise<any[]>;
}
declare module 'path' {
  export function join(...parts: string[]): string;
}
declare module 'hydrooj' {
  export class Context {
    Route(...args: any[]): any;
    injectUI(...args: any[]): any;
    db: any;
    setting: any;
    addScript(...args: any[]): any;
    on(...args: any[]): any;
  }
  export class Handler {
    args: any;
    request: any;
    response: any;
    session: any;
    user: any;
    checkPriv(...args: any[]): any;
  }
  export class ObjectId {
    constructor(value?: any);
    toHexString(): string;
  }
  export const PRIV: any;
  export const PERM: any;
  export const ContestModel: any;
  export const ProblemModel: any;
  export const UserModel: any;
  export const DomainModel: any;
  export function requireSudo(...args: any[]): any;
}
declare module '@hydrooj/ui-default' {
  export function addPage(...args: any[]): any;
  export class AutoloadPage {
    constructor(...args: any[]);
  }
  export class NamedPage {
    constructor(...args: any[]);
  }
}
declare const process: any;
declare const Buffer: any;
