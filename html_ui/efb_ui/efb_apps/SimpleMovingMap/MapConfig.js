/*
  Simple Moving Map - MapConfig.js

  This file lets users choose another Leaflet-compatible raster XYZ tile source.
  Restart MSFS 2024 after editing it.

  IMPORTANT:
  - Use a provider whose terms permit your intended use.
  - Keep the required attribution text for that provider.
  - API-key services should use the user's own key. Do not redistribute someone else's key.
  - This addon expects an XYZ raster URL containing {z}, {x}, and {y}.
  - Google Maps is NOT a simple drop-in XYZ source under Google's current terms/API model,
    so do not paste unofficial Google tile URLs here.

  Default: OpenTopoMap (OpenStreetMap-derived)
*/

window.SIMPLE_MOVING_MAP_CONFIG = {
  tileUrl: 'http://a.tile.opentopomap.org/{z}/{x}/{y}.png',
  attribution: '© OpenTopoMap · © OpenStreetMap contributors',
  minZoom: 4,
  maxZoom: 16,
  tileSize: 256,
  zoomOffset: 0,
  crossOrigin: true
};

/*
  MAPTILER EXAMPLE (user supplies their own API key)

  Replace the active config above with:

  window.SIMPLE_MOVING_MAP_CONFIG = {
    tileUrl: 'https://api.maptiler.com/maps/streets-v4/256/{z}/{x}/{y}.png?key=YOUR_MAPTILER_API_KEY',
    attribution: '© MapTiler · © OpenStreetMap contributors',
    minZoom: 1,
    maxZoom: 20,
    tileSize: 256,
    zoomOffset: 0,
    crossOrigin: true
  };
*/
