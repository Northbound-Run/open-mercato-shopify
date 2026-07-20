// Ambient shims for framework runtime dependencies that the consuming Open Mercato app provides
// but which are NOT installed in this standalone package. They exist only so `tsc` can resolve
// the framework's own source (the @open-mercato/* packages ship their types as .ts, so a deep
// import pulls in their internal imports too) without this package having to replicate the app's
// entire dependency graph. This package's own code never imports any of these directly —
// `awilix` (used by di.ts) is a real devDependency, not shimmed.

// Leaf modules used non-structurally by framework source — an `any` module is sufficient.
declare module 'ioredis'
declare module 'bcryptjs'
declare module 'next'
declare module 'next/server'
declare module 'next/headers'
declare module 'next/headers.js'
declare module '@open-mercato/search'
declare module '@open-mercato/search/*'
declare module '@open-mercato/ai-assistant'
declare module '@open-mercato/ai-assistant/*'
declare module '@open-mercato/events'
declare module '@open-mercato/events/index'

// Modules whose types the framework uses structurally (as generic types), so a bare `any` module
// isn't enough — provide the minimal shapes the framework's source references.
declare module '@open-mercato/queue' {
  export type Queue<T = unknown> = {
    enqueue(payload: T, opts?: unknown): Promise<unknown>
    [key: string]: unknown
  }
  export function createModuleQueue<T = unknown>(name: string, opts?: { concurrency?: number }): Queue<T>
  export function createQueue<T = unknown>(name: string, opts?: unknown): Queue<T>
  export function resolveQueueStrategy(...args: unknown[]): unknown
  export type QueuedJob<T = unknown> = { id: string; name: string; payload: T }
  export type JobContext = Record<string, unknown>
  export type WorkerMeta = { queue: string; id?: string; concurrency?: number }
}

declare module '@open-mercato/events/types' {
  // Deliberately loose (`any`): this only exists so the framework's own source resolves
  // `EventBus` as a callable type; this package never uses it directly.
  export interface EventBus {
    emit(...args: any[]): any
    emitEvent(...args: any[]): any
    on(...args: any[]): any
    [key: string]: any
  }
}
