# trip-group-maps

Offline area maps for [Trip Group](https://tripgroup.web.app): the organizer of a group orders an area (point + radius),
this repository cuts it out of the open [Protomaps](https://protomaps.com) daily OpenStreetMap build and publishes it on
GitHub Pages as a single `.pmtiles` file. The app downloads it to the phones of the group.

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL; basemap tiles by Protomaps.
- Worker: `.github/workflows/areas.yml` (every ~5 min) → `scripts/areas.mjs`.
- Firestore access: Workload Identity (no keys), service account `trip-maps-worker` (role Cloud Datastore User).
- Published files live only in the `gh-pages` branch (rewritten as a single commit each time, so the repo does not grow).
