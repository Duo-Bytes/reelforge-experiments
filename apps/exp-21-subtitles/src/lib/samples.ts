// Inline subtitle samples so the demo works without any user input.

export const SAMPLE_VTT = `WEBVTT

1
00:00:00.500 --> 00:00:03.500 align:center line:90%
Welcome to ReelForge.
This caption is rendered from a WebVTT cue.

2
00:00:03.800 --> 00:00:07.500 align:start line:10%
Top-left positioning via "line" + "align".

3
00:00:08.000 --> 00:00:12.000 align:center line:90%
WebVTT is the W3C standard
for captions on the web.

4
00:00:13.000 --> 00:00:18.000 align:end line:90%
Right-aligned closing card.
`;

export const SAMPLE_ASS = `[Script Info]
Title: Demo
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1
Style: Title,Arial,72,&H0000A8FF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,3,2,8,40,40,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:04.00,Title,,0,0,0,,{\\an8\\fad(400,400)}ReelForge ASS Renderer
Dialogue: 0,0:00:04.50,0:00:08.00,Default,,0,0,0,,{\\an2\\fad(300,300)}Bottom-centre caption (\\\\an2)
Dialogue: 0,0:00:08.50,0:00:12.00,Default,,0,0,0,,{\\an1}Bottom-left (\\\\an1)\\NSecond line via \\\\N
Dialogue: 0,0:00:12.50,0:00:16.00,Default,,0,0,0,,{\\an9\\c&H00FFFF&}Top-right with yellow override
Dialogue: 0,0:00:16.50,0:00:22.00,Title,,0,0,0,,{\\an5\\fad(800,800)}Centre with 800ms fades
`;
