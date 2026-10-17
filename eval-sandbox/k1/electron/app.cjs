const E = require('../engine/filename.js');
const MEDIA_EXT = /\.(mp4|webm|png)$/i;
const dirOf = () => process.env.MEDIA_DIR || '/tmp/media';

// Only a media file directly inside the media folder may be renamed or deleted.
const ownFile = (p) => typeof p === 'string' && E.isDirectChild(dirOf(), p) && MEDIA_EXT.test(p);

module.exports.ownFile = ownFile;

// The window title shows the clip label.
const titleOf = (clip) => 'Kite - ' + E.labelOf(clip.name);

module.exports.titleOf = titleOf;
