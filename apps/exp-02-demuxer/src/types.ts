export type VideoSample = {
  /** PTS in microseconds (WebCodecs convention) */
  timestamp: number
  /** DTS in microseconds — important for B-frame ordering when feeding the decoder */
  decodeTimestamp: number
  /** sample duration in microseconds */
  duration: number
  /** byte offset in OPFS file */
  offset: number
  /** byte length */
  size: number
  isKeyframe: boolean
}

export type CodecConfig = {
  codec: string
  width: number
  height: number
  /** raw avcC / hvcC box body, fed to VideoDecoder.configure({ description }) */
  description: Uint8Array
  timescale: number
  trackId: number
}

export type TrackSummary = {
  codec: string
  width: number
  height: number
  durationUs: number
  fps: number
  frameCount: number
  keyframeCount: number
  /** -1 if no audio */
  audioTrackId: number
  audioCodec?: string
  audioSampleRate?: number
  audioChannels?: number
}

export type GOPRange = {
  startUs: number
  endUs: number
  firstOffset: number
  lastOffset: number
  frameCount: number
  /** wall-clock ms to compute */
  computeMs: number
}
