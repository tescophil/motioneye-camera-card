# MotionEye Camera Card

[![HACS](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://hacs.xyz)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Lovelace card for Home Assistant that turns your [motionEye](https://github.com/motioneye-project/motioneye) cameras into a mobile-friendly camera wall.

## Features

- **Live MJPEG main view** from the camera entities created by Home Assistant's core `motioneye` integration
- **Grid layout**: a large main image with a tile grid below it. Tap a tile to promote that camera to the main view. A `single` layout with camera chips is also available
- **Recordings strip**: a horizontal, scrolling strip of the selected camera's latest videos and/or snapshots under the main image, newest first
- **Timeline tab**: all recent videos and snapshots, grouped by day, with an in-card player and viewer
- **Motion indication**: pulsing border and badge on the camera, plus a header alert when any camera sees motion
- **SD / HD / Auto**: switch to low-resolution streams on slow connections using Home Assistant's `proxy` camera platform
- **Mobile-friendly**: streams stop when the card is off-screen or the app is in the background; grid tiles use refreshed snapshots rather than many parallel streams
- **No cropping**: every image keeps its camera's real aspect ratio, so on-screen timestamps stay visible
- Visual editor, no build step, no dependencies

## Requirements

- Home Assistant with the core [motionEye integration](https://www.home-assistant.io/integrations/motioneye/) set up (this provides the `camera.*` entities, the MJPEG streams and the media browser)
- For the SD mode: low-resolution copies of your cameras (see [Low-resolution cameras](#low-resolution-cameras))

## Installation

### HACS (custom repository)

1. In HACS, open the three-dot menu and choose **Custom repositories**
2. Add `https://github.com/tescophil/motioneye-camera-card` with category **Dashboard** (called *Lovelace* in older HACS versions)
3. Find **MotionEye Camera Card** in HACS and install it
4. Reload your browser. HACS adds the dashboard resource for you

### Manual

1. Download `motioneye-camera-card.js` from the [latest release](https://github.com/tescophil/motioneye-camera-card/releases/latest)
2. Copy it to `/config/www/` (create the folder and restart Home Assistant if it doesn't exist)
3. Go to Settings, Dashboards, three-dot menu, Resources, and add `/local/motioneye-camera-card.js` as a **JavaScript module** (turn on Advanced mode in your user profile if you don't see Resources)
4. Hard-refresh the browser. When you change the file later, add a version to the URL (`/local/motioneye-camera-card.js?v=2`) to bypass the cache

## Quick start

Add the card from the dashboard editor (search for "MotionEye"), or paste YAML:

```yaml
type: custom:motioneye-camera-card
title: Cameras
cameras:
  - camera.living_room
  - camera.garage
  - camera.patio
```

A fuller example is in [`examples/dashboard.yaml`](examples/dashboard.yaml).

## Configuration

### Card options

| Option | Default | Description |
| --- | --- | --- |
| `cameras` | required | List of `camera.*` entities, or objects with the per-camera options below |
| `title` | none | Card title |
| `layout` | `grid` | `grid` (main image plus tile grid) or `single` (main image plus camera chips) |
| `default_quality` | `auto` | `auto`, `normal` (HD) or `low` (SD). The header button cycles Auto, SD and HD, and the choice is remembered per browser. This setting is only the starting point until you pick one |
| `thumb_mode` | `snapshot` | `snapshot` (tiles refresh as still images) or `stream` (a live MJPEG stream in every tile) |
| `thumb_quality` | `follow` | Which feed the grid tiles use: `follow` (same as the HD/SD button), `low` (always the low-res camera) or `normal` (always full-res) |
| `snapshot_interval` | `5` | Seconds between tile refreshes in `snapshot` mode (minimum 1) |
| `grid_columns` | `2` | Number of tile columns, 1 to 4 |
| `aspect_ratio` | `16:9` | Shape of the tiles, and of the main image until its first frame arrives. After that, every image follows its camera's real aspect ratio |
| `motion_hold` | `30` | Seconds to keep the motion indicator on after a motion event |
| `select_on_motion` | `false` | Make a camera the main camera when it starts detecting motion (see [Select on motion](#select-on-motion)) |
| `select_on_motion_lock` | `30` | Seconds after you pick a camera yourself during which select-on-motion leaves your choice alone (`0` = never wait) |
| `strip` | `true` | Show the recordings strip under the main image |
| `strip_content` | `both` | `both`, `videos` or `snapshots` |
| `strip_limit` | `30` | Maximum items in the strip, 1 to 100 |
| `strip_prefetch` | `true` | Load every camera's strip, and its first thumbnails, in the background so switching camera is instant (see [Background loading](#background-loading)) |
| `timeline` | `true` | Show the Timeline tab |
| `timeline_days` | `7` | How many of the newest days of recordings to load per camera. `0` loads every available day |
| `timeline_limit` | `500` | Maximum videos and maximum snapshots loaded **per day**, per camera (up to 2000) |

### Per-camera options

```yaml
cameras:
  - camera.living_room
  - entity: camera.garage
    name: Garage
    low_entity: camera.garage_sd
    motion_entity: binary_sensor.garage_motion
```

| Option | Default | Description |
| --- | --- | --- |
| `entity` | required | The motionEye camera entity |
| `name` | friendly name | Label shown on the camera |
| `low_entity` | `<entity>_low` | The low-resolution proxy camera to use for SD |
| `motion_entity` | none | A `binary_sensor` that is `on` while motion is detected |
| `movies_source` / `images_source` | auto | `media-source://motioneye/...` IDs for this camera's videos and snapshots. Only needed if automatic discovery can't find them |

## How it works

### Live view and tiles

The main image is a live MJPEG stream, opened with the camera entity's access token. Grid tiles refresh as snapshots by default, because browsers allow only about six simultaneous connections per host and several live streams would use them all. Set `thumb_mode: stream` if you have few cameras and want live tiles.

The stream is closed whenever the card is scrolled out of view, the browser tab or app is in the background, the Timeline tab is open, or a recording is being viewed. It reconnects with a short back-off if it drops, for example after a token rotation or a network change.

### SD / HD / Auto

- **HD** always uses the camera entity itself
- **SD** uses the low-resolution proxy camera (`camera.<name>_low` by default). If it doesn't exist, the card shows full resolution and a note explaining why
- **Auto** chooses SD when the browser reports Data Saver or a connection of 3G or slower, and HD otherwise. It re-checks when the connection changes

Auto relies on the browser's network information, which is available in Chromium-based browsers and the Android app. iOS Safari doesn't provide it, so Auto always chooses HD there and you should pick SD by hand. Auto doesn't distinguish Wi-Fi from mobile data: a fast mobile connection is treated as fast.

The grid tiles follow the same choice by default (`thumb_quality: follow`): switching to SD changes both the main image and the tiles to the low-resolution feeds, and switching back restores full resolution. Set `thumb_quality` to `low` or `normal` if you want the tiles fixed either way. A tile whose low-resolution camera doesn't exist keeps showing full resolution.

### Low-resolution cameras

Home Assistant's `proxy` camera can only be configured in YAML, so the card can't create these entities for you. The visual editor has a **Low-resolution proxy cameras (YAML)** section that generates the block for the cameras you chose. You can also start from [`examples/proxy_cameras.yaml`](examples/proxy_cameras.yaml):

```yaml
camera:
  - platform: proxy
    entity_id: camera.living_room
    name: "Living Room Low"      # becomes camera.living_room_low
    mode: resize
    max_image_width: 480
    image_quality: 50
    max_stream_width: 480
    stream_quality: 50
```

Merge this with any existing `camera:` section in `configuration.yaml` and restart Home Assistant. The entity name must end in `_low` (or set `low_entity`). The proxy resizes each frame on the Home Assistant host, so it uses CPU while someone watches an SD stream. If your hardware struggles, lower `max_stream_width` or `stream_quality`.

### Motion indication

Motion is shown from either of these sources:

1. The `motioneye.motion_detected` event, fired by the core integration. This needs motionEye to be able to reach Home Assistant's webhook, so check the internal and external URLs in Settings, System, Network
2. An optional `motion_entity` binary sensor per camera

The indicator stays on for `motion_hold` seconds after an event. New recordings usually appear about 20 seconds after motion starts, and the strip and timeline refresh themselves at that point.

### Select on motion

With `select_on_motion: true`, a camera that starts detecting motion becomes the main camera. Details:

- It only acts when a camera's motion *starts*. A camera that stays in motion doesn't keep pulling the view back, and if several cameras start at once the first one in your list wins
- It only acts on the Live tab, and not while a recording is open
- If you tap a camera yourself, auto-select waits `select_on_motion_lock` seconds (default 30) before it can switch again, so it doesn't fight you
- It uses the same motion sources as the indicator (the `motioneye.motion_detected` event or a `motion_entity`)

### Recordings strip

Under the main image, a horizontal strip shows the selected camera's newest recordings first (leftmost). Scroll sideways to go back in time, and tap an item to open it. Use `strip_content` to show videos, snapshots or both. Items from earlier days show a short date before the time. Every clip is the same size, using the selected camera's shape. If motionEye has no thumbnail for a clip, a small video or photo icon is shown in its place.

### Background loading

So that tapping a different camera doesn't wait on motionEye, the card prepares the other cameras' strips ahead of time (`strip_prefetch`, on by default):

- **Placeholders:** the strip is on screen from the first draw, as a row of same-size grey tiles while the recordings load. It doesn't resize or jump when the clips arrive, and the same goes for "No recordings yet" and error messages
- **Other cameras:** once the selected camera's strip has loaded, the others are loaded one at a time, with a short pause between each, so Home Assistant and motionEye aren't hit all at once
- **Thumbnails:** the first 8 thumbnails of each camera are downloaded in the background (two at a time, and always behind anything you can actually see) and kept in memory, so they appear immediately
- **Always fresh:** strips refresh about every two minutes, and about 20 seconds after a camera detects motion. A refresh never blanks the strip. You keep seeing the current clips, and the strip only redraws if something has changed
- **Data saving:** when the quality is SD (or Auto has chosen SD), thumbnails are not preloaded, only the ones you scroll to. The lists are still prefetched, as they're tiny
- **Opting out:** set `strip_prefetch: false` if you'd rather the card only ever loads the camera on screen

### Timeline tab

The Timeline tab browses motionEye's media source, merges videos and snapshots, and groups them by day. Filter by All, Videos or Images, and tap any item to play or view it. The viewer has newer/older buttons and a download link.

A summary line at the top shows how many days were loaded, how many videos and snapshots were found, and whether any day hit `timeline_limit`.

Dates and times are read from motionEye's default `YYYY-MM-DD` folders with `HH-MM-SS` file names. With a custom file naming pattern, items may be listed under "Unknown date".

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| "Custom element doesn't exist: motioneye-camera-card" | The resource isn't loaded. Check the resource URL and type (*JavaScript module*), then hard-refresh. In the companion app, use Settings, Companion app, Debugging, Reset frontend cache |
| The image stays on "Connecting..." | Open the camera entity's own more-info dialog. If it doesn't stream there either, the problem is in the motionEye integration or the motionEye server |
| SD shows a "Low-res camera ... not found" note | The proxy camera doesn't exist yet. Add the YAML above and restart Home Assistant, or set `low_entity` |
| Motion never shows | Check that `motioneye.motion_detected` events appear in Developer Tools, Events (listen to it), or set `motion_entity` |
| Timeline says the camera wasn't found in the media source | Set `movies_source` and `images_source` on that camera. Browse the media in Home Assistant's Media panel to find the IDs |
| Timeline shows fewer days than expected | Read the summary line. It says how many days were found and loaded, and whether any day was capped. Raise `timeline_days` or `timeline_limit` as it suggests |
| Timeline or strip shows "Unknown date" | Your motionEye file or folder names aren't in the default date format |
| A grid tile still shows the full-res picture in SD mode | That camera has no low-res copy. Check that `camera.<name>_low` exists, or set `low_entity` |
| Tiles are different heights | Your cameras have different aspect ratios. Each tile follows its own camera's real shape |

## Limitations

- Reading the entity registry, used to match cameras to motionEye devices, is admin-only. Non-admin users fall back to matching by camera name
- Full-screen uses the browser's fullscreen mode where available, and falls back to filling the window on iOS
- The card has been built against Home Assistant's documented APIs and the motionEye integration's media source. If something doesn't match your setup, please open an issue with the card's error text

## Publishing to the HACS default list

The repository already includes `hacs.json` and a validation workflow. To be listed in HACS without adding a custom repository, it needs to be public, have a description and topics, have at least one GitHub release, pass the HACS validation action, and be submitted as a pull request to [hacs/default](https://github.com/hacs/default).

## Development

There's no build step. The card is a single file, `motioneye-camera-card.js`.

```bash
node --check motioneye-camera-card.js   # syntax check
node --test                             # unit tests for the pure helpers
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

## Licence

[MIT](LICENSE)
