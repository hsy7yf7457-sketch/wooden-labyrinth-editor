# House ads (cross-promotion)

The lite version of Wooden Labyrinth 3D shows a full-screen "house ad" for our
own games once every 4 completed levels. There is **no third-party ad SDK** —
ads are just static files described by `ads.json`, served from
hammer-golf.com (GitHub Pages). No IDFA / App Tracking Transparency is needed
because nothing is tracked and we only promote our own apps.

## How the app uses it

On launch (lite only) the game fetches the manifest and pre-downloads every
creative to disk, so ads display instantly and keep working offline. It tries:

1. `https://hammer-golf.com/editor/ads/ads.json`
2. `https://raw.githubusercontent.com/hsy7yf7457-sketch/wooden-labyrinth-editor/main/ads/ads.json`

(the GitHub raw fallback means a freshly published ad works even before the
hammer-golf.com Pages rebuild finishes).

## Adding an ad

1. Drop the creative into this folder, e.g. `img/my-other-game.png` or
   `video/trailer.mp4`.
2. Add an entry to the `ads` array in `ads.json`:

```json
{
  "id": "my-other-game",
  "type": "image",
  "url": "https://hammer-golf.com/editor/ads/img/my-other-game.png",
  "click": "https://apps.apple.com/app/id000000000",
  "weight": 2,
  "minDisplay": 3,
  "maxShows": 5
}
```

3. Commit & deploy (the file must end up at
   `hammer-golf.com/editor/ads/...`).

### Fields

| Field        | Required | Meaning                                                            |
|--------------|----------|-------------------------------------------------------------------|
| `id`         | yes      | Short identifier, used in analytics (`house_ad_shown` / `_clicked`) **and** to track the per-device show count. Keep it stable. |
| `type`       | yes      | `"image"` or `"video"`.                                            |
| `url`        | yes      | Absolute URL to the creative. Cached on-device by URL.            |
| `click`      | no       | URL opened when the user taps the ad (e.g. App Store link).        |
| `weight`     | no       | Relative selection weight (default 1). Higher = shown more often.  |
| `minDisplay` | no       | Seconds before the close (✕) button appears (default 0).          |
| `maxShows`   | no       | Max times this ad is shown **per device**, by `id`. Once reached, it's retired. `0` / omitted = unlimited. When every ad is exhausted, no more ads show. |

## Creative guidance

- **Image**: landscape, e.g. 1334×750 or 2048×1536 PNG/JPG. Shown aspect-fit.
- **Video**: landscape MP4 (H.264 + AAC). Keep it short; the close button
  appears after `minDisplay` seconds or when the video ends.

## Analytics

Impressions and taps are logged to GameAnalytics as design events
`house_ad_shown` and `house_ad_clicked` (with the ad `id`).
