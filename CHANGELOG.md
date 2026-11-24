# Changelog

## 1.1.0

- **New:** `select_on_motion` makes a camera the main camera when it starts detecting motion, with `select_on_motion_lock` to leave your own choice alone for a while
- **Changed:** grid tiles now follow the HD/SD button, so switching to SD changes the tiles as well as the main image. This replaces `thumb_low_res` with `thumb_quality` (`follow`, `low` or `normal`); an existing `thumb_low_res` setting is ignored
- **New:** the recordings strip shows same-size placeholder tiles from the first draw (and keeps its height in empty and error states), so it no longer looks blank or jumps in size while loading
- **New:** `strip_prefetch` loads every camera's strip and its first thumbnails in the background, so switching camera is instant. Strips refresh quietly without blanking, and thumbnails aren't preloaded on SD
- **Fixed:** a thin black bar along the top of video clips in the strip and timeline. Thumbnails close to the tile's shape now fill it edge to edge; very different ones (such as a generic placeholder picture) are still shown whole
- **Fixed:** a thin black border around the live image and grid tiles. The selection and motion highlights are now drawn as an outline, so nothing shows around a tile that isn't highlighted
- **Fixed:** recording clips whose thumbnail was a generic placeholder were shown at a different size and broke the strip and timeline layout. All clips are now the same size

## 1.0.0

Initial release.

- Live MJPEG main view with a tile grid (tap to promote) or single layout with camera chips
- SD / HD / Auto quality, using Home Assistant `proxy` cameras for SD
- Motion indication from the `motioneye.motion_detected` event and optional binary sensors
- Recordings strip under the main image (videos, snapshots or both)
- Timeline tab of motionEye videos and snapshots grouped by day, with an in-card player
- Per-day loading with `timeline_days` and `timeline_limit`, and a load summary line
- Images keep each camera's real aspect ratio
- Visual editor, including a generator for the low-resolution proxy camera YAML
- HACS support
