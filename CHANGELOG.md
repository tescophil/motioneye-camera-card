# Changelog

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
