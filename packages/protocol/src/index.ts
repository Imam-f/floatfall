import { Schema } from "effect"

export * from "./lite"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** A YouTube video the extension detected in a browser tab. */
export const Video = Schema.Struct({
  videoId: Schema.String,
  title: Schema.String,
  url: Schema.String,
  tabId: Schema.Number
})
export type Video = typeof Video.Type

/** One transcribed note. `pitch` is a MIDI note number, times are seconds. */
export const Note = Schema.Struct({
  pitch: Schema.Number,
  start: Schema.Number,
  end: Schema.Number,
  velocity: Schema.optionalKey(Schema.Number)
})
export type Note = typeof Note.Type

/**
 * What the transcriber command must write to its `{output}` file when the
 * configured output format is `json`. Either a bare array or `{ notes: [...] }`.
 */
export const TranscriptionFile = Schema.Union([
  Schema.Array(Note),
  Schema.Struct({ notes: Schema.Array(Note) })
])
export type TranscriptionFile = typeof TranscriptionFile.Type

/** Snapshot of the YouTube `<video>` element playback state. */
export const Playback = Schema.Struct({
  videoId: Schema.String,
  time: Schema.Number,
  rate: Schema.Number,
  paused: Schema.Boolean
})
export type Playback = typeof Playback.Type

// ---------------------------------------------------------------------------
// Extension -> Desktop
// ---------------------------------------------------------------------------

export const ClientMessage = Schema.Union([
  Schema.TaggedStruct("Hello", { version: Schema.Number }),
  Schema.TaggedStruct("ActiveVideo", { video: Schema.NullOr(Video) }),
  Schema.TaggedStruct("Playback", { playback: Playback }),
  Schema.TaggedStruct("Ping", {})
])
export type ClientMessage = typeof ClientMessage.Type

// ---------------------------------------------------------------------------
// Desktop -> Extension
// ---------------------------------------------------------------------------

export const ServerMessage = Schema.Union([
  Schema.TaggedStruct("Welcome", { version: Schema.Number }),
  Schema.TaggedStruct("Seek", { videoId: Schema.String, time: Schema.Number }),
  Schema.TaggedStruct("Pong", {})
])
export type ServerMessage = typeof ServerMessage.Type

export const ClientMessageJson = Schema.fromJsonString(ClientMessage)
export const ServerMessageJson = Schema.fromJsonString(ServerMessage)

// ---------------------------------------------------------------------------
// Content script <-> background (inside the extension)
// ---------------------------------------------------------------------------

export const ContentMessage = Schema.Union([
  Schema.TaggedStruct("Playback", { playback: Playback }),
  Schema.TaggedStruct("Title", { videoId: Schema.String, title: Schema.String })
])
export type ContentMessage = typeof ContentMessage.Type

export const BackgroundToContent = Schema.TaggedStruct("Seek", {
  videoId: Schema.String,
  time: Schema.Number
})
export type BackgroundToContent = typeof BackgroundToContent.Type

