// Builds the ffmpeg arguments for an export.
function exportArgs({ input, output, crf = 23 }) {
  return ['-y', '-i', input, '-c:v', 'libx264', '-crf', String(crf), '-pix_fmt', 'yuv420p', output];
}

module.exports = { exportArgs };
