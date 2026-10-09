# Simple EFB Moving Map

Simple EFB Moving Map is a lightweight OpenTopoMap/OpenStreetMap moving-map app for the Microsoft Flight Simulator 2024 EFB. It shows your aircraft on a north-up map and can draw the active EFB flight plan with labelled waypoints. It is based on the [original Simple EFB Moving Map release on Flightsim.to](https://flightsim.to/addon/114508/simple-efb-moving-map).

## Installation & Usage

1. Download ZIP release (EFB-simple-moving-map.zip) and unpack it to your MSFS 2024 Community folder.
2. Start Microsoft Flight Simulator 2024.
3. Open the EFB and select **Simple Moving Map**.

## What's new

- **Live EFB flight plans:** the app now reads the active MSFS 2024 EFB route directly. No exported or manually replaced `FlightPlan.PLN` file is needed.
- **More complete route support:** it uses the EFB route when available, falls back to the simulator flight-plan manager, and resolves missing waypoint positions when possible.
- **Reliable, clean route display:** the route is Canvas-rendered for EFB compatibility; hiding it also clears its labels and graphics.
- **Smoother map behavior:** aircraft position and heading update while the app is visible, and the map recovers from EFB resize, hide, and resume events.
- **Improved controls:** wheel zoom stays centred on the aircraft in follow mode, or on the pointer after you pan the map. Your zoom level is retained while the app remains open.

## Using the map

Create or open a flight plan in the MSFS 2024 EFB. In Simple Moving Map, use the route button (three connected dots) to show the active route; use it again to hide the route. If you change the plan, hide and show the route again to reload it.

The target button controls aircraft-follow mode. Dragging the map turns following off so you can inspect another area; press the target button to re-center on and follow the aircraft again. Use the **+** and **-** buttons, or the mouse wheel, to zoom.

## Changing the map provider

Edit `html_ui/efb_ui/efb_apps/SimpleMovingMap/MapConfig.js`, then restart MSFS 2024. Enter a Leaflet-compatible raster XYZ URL containing `{z}`, `{x}`, and `{y}`, and set the provider's required attribution. Use your own API key for providers that require one, and follow the provider's terms of use. The included configuration contains a MapTiler example.

The default map is OpenTopoMap, with OpenStreetMap contributor attribution.
