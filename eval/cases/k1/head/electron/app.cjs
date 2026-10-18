const E = require('../engine/filename.js');
const MEDIA_EXT = /\.(mp4|webm|png)$/i;
const dirOf = () => process.env.MEDIA_DIR || '/tmp/media';

// Only a media file directly inside the media folder may be renamed or deleted.
const ownFile = (candidate) => typeof candidate === 'string' && MEDIA_EXT.test(candidate) && E.isDirectChild(dirOf(), candidate);

module.exports.ownFile = ownFile;

// The window title shows the clip label.
const titleOf = (clip) => 'Sample - ' + E.labelOf(clip.name);

module.exports.titleOf = titleOf;
