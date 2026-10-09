(function () {
  'use strict';

  const APP_NAME = 'Simple Moving Map';
  const INTERNAL_NAME = 'SimpleMovingMap';
  const VERSION = '2.1.4';
  const BASE_URL = 'coui://html_ui/efb_ui/efb_apps/SimpleMovingMap';
  const MIN_ZOOM = 4;
  const MAX_ZOOM = 16;
  const DEFAULT_ZOOM = 10;
  const DEFAULT_MAP_CONFIG = {
    tileUrl: 'http://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenTopoMap · © OpenStreetMap contributors',
    minZoom: 4,
    maxZoom: 16,
    tileSize: 256,
    zoomOffset: 0,
    crossOrigin: false
  };

  function getSdk() {
    return window.msfssdk || (typeof msfssdk !== 'undefined' ? msfssdk : null);
  }

  function getSimVar(name, unit) {
    try {
      if (window.SimVar && typeof window.SimVar.GetSimVarValue === 'function') {
        return Number(window.SimVar.GetSimVarValue(name, unit));
      }
      if (typeof SimVar !== 'undefined' && typeof SimVar.GetSimVarValue === 'function') {
        return Number(SimVar.GetSimVarValue(name, unit));
      }
    } catch (_) {}
    return NaN;
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      // MSFS 2024 system EFB can mis-handle Leaflet's nested CSS GPU transforms.
      // Force Leaflet to use its simpler top/left positioning path before it initializes.
      window.L_DISABLE_3D = true;
      if (window.L && typeof window.L.map === 'function') {
        resolve();
        return;
      }
      const existing = Array.from(document.scripts).find(s => s.src === src || s.getAttribute('src') === src);
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        window.setTimeout(() => {
          if (window.L && typeof window.L.map === 'function') resolve();
        }, 0);
        return;
      }
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = src;
      script.async = false;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', reject, { once: true });
      document.head.appendChild(script);
    });
  }

  function loadCssOnce(href) {
    if (Array.from(document.styleSheets).some(s => s.href === href)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  function loadPlainScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = Array.from(document.scripts).find(s => s.src === src || s.getAttribute('src') === src);
      if (existing) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = src;
      script.async = false;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', reject, { once: true });
      document.head.appendChild(script);
    });
  }

  function getMapConfig() {
    const user = window.SIMPLE_MOVING_MAP_CONFIG || {};
    return Object.assign({}, DEFAULT_MAP_CONFIG, user);
  }

  function validLatLon(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  function parsePlnCoordinatePart(value) {
    value = String(value || '').trim();
    const decimal = Number(value);
    if (Number.isFinite(decimal)) return decimal;
    const hemisphere = value.match(/^([NSEW])/i);
    const numbers = value.match(/\d+(?:\.\d+)?/g);
    if (!hemisphere || !numbers || !numbers.length) return NaN;
    let result = (Number(numbers[0]) || 0) + (Number(numbers[1]) || 0) / 60 + (Number(numbers[2]) || 0) / 3600;
    if (/^[SW]$/i.test(hemisphere[1])) result = -result;
    return result;
  }

  function parseWorldPosition(value) {
    const parts = String(value || '').split(',');
    if (parts.length < 2) return null;
    const lat = parsePlnCoordinatePart(parts[0]);
    const lon = parsePlnCoordinatePart(parts[1]);
    return validLatLon(lat, lon) ? [lat, lon] : null;
  }

  function loadPackageText(url) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.onreadystatechange = function () {
        if (this.readyState !== XMLHttpRequest.DONE) return;
        // This matches MSFS's shipped Utils.loadFile implementation. Coherent's
        // coui:// protocol commonly reports a successful local load as status 0.
        if (this.status === 200 || this.status === 0) resolve(this.responseText);
        else reject(new Error('Unable to load file, got HTTP ' + this.status));
      };
      request.open('GET', url);
      request.send();
    });
  }

  function destinationPoint(latDeg, lonDeg, bearingDeg, distanceNm) {
    if (!validLatLon(latDeg, lonDeg) || !Number.isFinite(bearingDeg) || !Number.isFinite(distanceNm)) {
      return null;
    }
    const earthRadiusNm = 3440.065;
    const phi1 = latDeg * Math.PI / 180;
    const lambda1 = lonDeg * Math.PI / 180;
    const theta = bearingDeg * Math.PI / 180;
    const delta = distanceNm / earthRadiusNm;
    const sinPhi2 = Math.sin(phi1) * Math.cos(delta)
      + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
    const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
    const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
    const x = Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2);
    let lambda2 = lambda1 + Math.atan2(y, x);
    lambda2 = (lambda2 + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    return [phi2 * 180 / Math.PI, lambda2 * 180 / Math.PI];
  }

  function makeViewClass(sdk) {
    return class SimpleMovingMapView extends sdk.DisplayComponent {
      constructor(props) {
        super(props);
        this.rootRef = sdk.FSComponent.createRef();
        this.mapRef = sdk.FSComponent.createRef();
        this.planeRef = sdk.FSComponent.createRef();
        this.map = null;
        this.tileLayer = null;
        this.flightPlanLayer = null;
        this.flightPlanRenderer = null;
        this.flightPlanLabelLayer = null;
        this.flightPlanWaypoints = [];
        this.flightPlanPoints = [];
        this.flightPlanVisible = false;
        this.fixedPlanLoadId = 0;
        this.followAircraft = true;
        this.routeListener = null;
        this.facilityViewListener = null;
        this.pendingAirportLoads = [];
        this.routeTimer = null;
        this.routeRefreshBusy = false;
        this.facilityLoader = null;
        this.mapConfig = getMapConfig();
        this.timer = null;
        this.resizeObserver = null;
        this.mutationObserver = null;
        this.viewportTimer = null;
        this.lastViewportWidth = 0;
        this.lastViewportHeight = 0;
        this.lastGoodZoom = DEFAULT_ZOOM;
        this.sessionZoom = DEFAULT_ZOOM;
        this.rebuildPending = false;
        this.lastHeading = NaN;
        this.lastLat = NaN;
        this.lastLon = NaN;
        this._mapWheelHandler = null;
        this._lastWheelZoomAt = 0;
        this.destroyed = false;
      }

      onAfterRender() {
        const root = this.rootRef.instance;
        const mapNode = this.mapRef.instance;
        if (!root || !mapNode || !window.L) return;

        const lat = getSimVar('PLANE LATITUDE', 'degrees');
        const lon = getSimVar('PLANE LONGITUDE', 'degrees');
        const startLat = Number.isFinite(lat) ? lat : 0;
        const startLon = Number.isFinite(lon) ? lon : 0;

        this.lastGoodZoom = DEFAULT_ZOOM;
        this.initFacilityLoader();
        this.createMap(startLat, startLon, this.lastGoodZoom);

        const plus = root.querySelector('[data-map-action="zoom-in"]');
        const minus = root.querySelector('[data-map-action="zoom-out"]');
        const routeToggle = root.querySelector('[data-map-action="route-toggle"]');
        const followToggle = root.querySelector('[data-map-action="follow-toggle"]');
        if (plus) plus.addEventListener('click', () => {
          if (this.map) {
            this.map.zoomIn(1);
            this.lastGoodZoom = this.map.getZoom();
            this.sessionZoom = this.lastGoodZoom;
            this.ensureViewport(true);
          }
        });
        if (minus) minus.addEventListener('click', () => {
          if (this.map) {
            this.map.zoomOut(1);
            this.lastGoodZoom = this.map.getZoom();
            this.sessionZoom = this.lastGoodZoom;
            this.ensureViewport(true);
          }
        });

        if (routeToggle) routeToggle.addEventListener('click', () => {
          this.setFlightPlanVisible(!this.flightPlanVisible);
        });
        if (followToggle) followToggle.addEventListener('click', () => {
          this.setFollowAircraft(!this.followAircraft, true);
        });
        this.updateControlStates();


        if (typeof ResizeObserver !== 'undefined') {
          this.resizeObserver = new ResizeObserver(() => this.ensureViewport(true));
          this.resizeObserver.observe(root);
          this.resizeObserver.observe(mapNode);
        }

        // MSFS can hide/re-show EFB apps without a reliable resize/open event.
        // Observe shell mutations and also poll the real viewport so recovery does
        // not depend on simulator lifecycle callbacks.
        if (typeof MutationObserver !== 'undefined') {
          this.mutationObserver = new MutationObserver(() => {
            window.setTimeout(() => this.ensureViewport(true), 0);
            window.setTimeout(() => this.ensureViewport(true), 100);
          });
          this.mutationObserver.observe(document.documentElement, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ['class', 'style', 'data-mode', 'data-page']
          });
        }

        window.addEventListener('resize', this._simpleResizeHandler = () => this.ensureViewport(true));
        this.startMapCycles();
      }

startMapCycles() {
  // Pro jistotu nejprve vyčistíme staré běžící intervaly
  this.stopMapCycles();
  if (this.destroyed) return;

  // Prvotní okamžitá synchronizace při otevření mapy
  this.ensureViewport(true);
  this.updateAircraftHeading(true);
  this.syncPosition(true);
  
  // Interval 1: Pozice letadla (4x za sekundu)
  this.timer = window.setInterval(() => this.syncPosition(false), 250);
  
  // Interval 2: Kontrola velikosti okna (1x za sekundu)
  this.viewportTimer = window.setInterval(() => this.ensureViewport(false), 1000);

/*  // Interval 3: Aktualizace letového plánu z EFB (1x za 8 sekund)
  if (this.routeTimer === null) {
    this.routeTimer = window.setInterval(() => {
      // HLAVNÍ POJISTKA: Pokud uživatel tlačítko vypnul, ihned interval ukončíme a nic nestahujeme!
      if (!this.flightPlanVisible || this.destroyed) {
        if (this.routeTimer !== null) {
          window.clearInterval(this.routeTimer);
          this.routeTimer = null;
        }
        return;
      }

      if (!this.routeRefreshBusy) {
        const vp = this.getVisibleViewport();
        if (!vp || vp.width <= 200 || vp.height <= 200) {
          return; // Aplikace je skrytá na pozadí, nestahovat
        }

        this.routeRefreshBusy = true; 
        this.reloadFixedFlightPlan(true).then(() => {
          this.routeRefreshBusy = false;
        }).catch(() => {
          this.routeRefreshBusy = false;
        });
      }
    }, 8000);
  } */
}

stopMapCycles() {
  if (this.timer !== null) {
    window.clearInterval(this.timer);
    this.timer = null;
  }
  if (this.viewportTimer !== null) {
    window.clearInterval(this.viewportTimer);
    this.viewportTimer = null;
  }
  if (this.routeTimer !== null) {
    window.clearInterval(this.routeTimer);
    this.routeTimer = null;
  }
  this.routeRefreshBusy = false; // Reset stavu zaneprázdnění
}

      createMap(lat, lon, zoom) {
        const mapNode = this.mapRef.instance;
        zoom = Number.isFinite(this.sessionZoom) ? this.sessionZoom : zoom;
        if (!mapNode || !window.L) return;

        // Remove any stale Leaflet DOM/classes left by a previous instance.
        if (this.map) {
          try { this.lastGoodZoom = this.map.getZoom(); } catch (_) {}
          try { this.map.remove(); } catch (_) {}
          this.map = null;
        }
        mapNode.innerHTML = '';
        mapNode.classList.remove('leaflet-container', 'leaflet-touch', 'leaflet-retina', 'leaflet-fade-anim');

        const cfg = this.mapConfig || getMapConfig();
        const minZoom = Number.isFinite(Number(cfg.minZoom)) ? Number(cfg.minZoom) : MIN_ZOOM;
        const maxZoom = Number.isFinite(Number(cfg.maxZoom)) ? Number(cfg.maxZoom) : MAX_ZOOM;

        this.map = window.L.map(mapNode, {
          attributionControl: false,
          zoomControl: false,
          dragging: true,
          touchZoom: false,
          doubleClickZoom: false,
          scrollWheelZoom: false,
          boxZoom: false,
          keyboard: false,
          tap: false,
          inertia: false,
          zoomAnimation: false,
          fadeAnimation: false,
          markerZoomAnimation: false,
          minZoom,
          maxZoom
        }).setView([lat, lon], Math.max(minZoom, Math.min(maxZoom, zoom)));

        this.tileLayer = window.L.tileLayer(String(cfg.tileUrl || DEFAULT_MAP_CONFIG.tileUrl), {
          tileSize: Number(cfg.tileSize) || 256,
          minZoom,
          maxZoom,
          zoomOffset: Number(cfg.zoomOffset) || 0,
          updateWhenIdle: false,
          keepBuffer: 2,
          crossOrigin: cfg.crossOrigin === true,
          attribution: String(cfg.attribution || DEFAULT_MAP_CONFIG.attribution)
        }).addTo(this.map);

        // HTML waypoint labels render correctly in Coherent, but its default
        // Leaflet SVG path layer may not. Force the route onto Canvas instead.
        const routePane = this.map.createPane('simple-route-pane');
        routePane.style.zIndex = '450';
        routePane.style.pointerEvents = 'none';
        if (typeof window.L.canvas === 'function') {
          this.flightPlanRenderer = window.L.canvas({ pane: 'simple-route-pane', padding: 0.5 });
        }

        const attribution = this.rootRef.instance && this.rootRef.instance.querySelector('.simple-attribution');
        if (attribution) attribution.textContent = String(cfg.attribution || DEFAULT_MAP_CONFIG.attribution);

        this.map.on('zoomend', () => {
          if (this.map) {
            this.lastGoodZoom = this.map.getZoom();
            this.sessionZoom = this.lastGoodZoom;
            this.updateAircraftScreenPosition();
          }
        });

        this.map.on('dragstart', () => {
          // A deliberate manual pan means the user no longer wants aircraft-follow.
          this.setFollowAircraft(false, false);
        });

        // Coherent/MSFS EFB passes DOM wheel input to the app. Leaflet's built-in
        // wheel zoom is intentionally disabled above so we can choose the zoom
        // anchor ourselves: aircraft while following, mouse cursor after panning.
        if (this._mapWheelHandler) {
          try { mapNode.removeEventListener('wheel', this._mapWheelHandler); } catch (_) {}
        }
        this._mapWheelHandler = (event) => {
          if (!this.map || this.destroyed) return;

          // Keep the EFB/page itself from scrolling while the pointer is over the map.
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();

          const deltaY = Number(event && event.deltaY);
          if (!Number.isFinite(deltaY) || deltaY === 0) return;

          // One deliberate zoom step per wheel notch/gesture. The short gate prevents
          // high-frequency wheel events from making the map jump several levels at once.
          const now = Date.now();
          if (now - this._lastWheelZoomAt < 75) return;
          this._lastWheelZoomAt = now;

          const currentZoom = this.map.getZoom();
          const min = this.map.getMinZoom();
          const max = this.map.getMaxZoom();
          const targetZoom = Math.max(min, Math.min(max, currentZoom + (deltaY < 0 ? 1 : -1)));
          if (targetZoom === currentZoom) return;

          if (this.followAircraft) {
            let lat = Number.isFinite(this.lastLat) ? this.lastLat : getSimVar('PLANE LATITUDE', 'degrees');
            let lon = Number.isFinite(this.lastLon) ? this.lastLon : getSimVar('PLANE LONGITUDE', 'degrees');
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
              const center = this.map.getCenter();
              lat = center.lat;
              lon = center.lng;
            }
            this.map.setView([lat, lon], targetZoom, { animate: false, reset: false });
          } else {
            // After manual panning, preserve the geographic point under the cursor.
            // Leaflet's setZoomAround performs the required center compensation.
            let anchor = null;
            try { anchor = this.map.mouseEventToLatLng(event); } catch (_) {}
            if (anchor && typeof this.map.setZoomAround === 'function') {
              this.map.setZoomAround(anchor, targetZoom, { animate: false });
            } else {
              this.map.setZoom(targetZoom, { animate: false });
            }
          }

          this.lastGoodZoom = targetZoom;
          this.sessionZoom = targetZoom;
        };
        mapNode.addEventListener('wheel', this._mapWheelHandler, { passive: false });

        this.map.on('move', () => this.updateAircraftScreenPosition());
        this.map.on('viewreset', () => this.updateAircraftScreenPosition());

        this.drawFlightPlan();
        this.updateControlStates();
      }

      initFacilityLoader() {
        try {
	  const currentSdk = this.props.sdk;  
          if (!currentSdk.FacilityLoader || !currentSdk.FacilityRepository || !this.props || !this.props.bus) {
            this.facilityLoader = null;
          } else {
            const repo = currentSdk.FacilityRepository.getRepository(this.props.bus);
            this.facilityLoader = new currentSdk.FacilityLoader(repo, () => {});
          }
        } catch (e) {
          console.warn('[Simple Moving Map] FacilityLoader unavailable:', e);
          this.facilityLoader = null;
        }

        // Fallback for airport endpoints. This is the same native facility path
        // used by MSFS developers when resolving IcaoValue airport structs.
        const registerListener = window.RegisterViewListener
          || (typeof RegisterViewListener !== 'undefined' ? RegisterViewListener : null);

        if (typeof registerListener === 'function') {
          try {
            this.facilityViewListener = registerListener('JS_LISTENER_FACILITY', () => {
              if (!this.facilityViewListener || typeof this.facilityViewListener.on !== 'function') return;
              this.facilityViewListener.on('SendAirport', facility => {
                const pending = this.pendingAirportLoads.shift();
                if (pending) pending.resolve(facility || null);
              });
            });
          } catch (e) {
            console.warn('[Simple Moving Map] Facility view listener unavailable:', e);
          }
        }
      }

      async loadAirportFallback(icao) {
        const coherent = window.Coherent || (typeof Coherent !== 'undefined' ? Coherent : null);
        if (!coherent || typeof coherent.call !== 'function' || !this.facilityViewListener) return null;

        return await new Promise(resolve => {
          let settled = false;
          const pending = {
            resolve: facility => {
              if (settled) return;
              settled = true;
              resolve(facility || null);
            }
          };

          this.pendingAirportLoads.push(pending);

          const timeout = window.setTimeout(() => {
            const index = this.pendingAirportLoads.indexOf(pending);
            if (index >= 0) this.pendingAirportLoads.splice(index, 1);
            pending.resolve(null);
          }, 2500);

          const originalResolve = pending.resolve;
          pending.resolve = facility => {
            window.clearTimeout(timeout);
            originalResolve(facility);
          };

          try {
            coherent.call('LOAD_AIRPORT_FROM_STRUCT', icao, 0).then(valid => {
              if (!valid) {
                const index = this.pendingAirportLoads.indexOf(pending);
                if (index >= 0) this.pendingAirportLoads.splice(index, 1);
                pending.resolve(null);
              }
            }).catch(() => {
              const index = this.pendingAirportLoads.indexOf(pending);
              if (index >= 0) this.pendingAirportLoads.splice(index, 1);
              pending.resolve(null);
            });
          } catch (_) {
            const index = this.pendingAirportLoads.indexOf(pending);
            if (index >= 0) this.pendingAirportLoads.splice(index, 1);
            pending.resolve(null);
          }
        });
      }

      updateControlStates() {
        const root = this.rootRef.instance;
        if (!root) return;
        const routeButton = root.querySelector('[data-map-action="route-toggle"]');
        const followButton = root.querySelector('[data-map-action="follow-toggle"]');
        if (routeButton) routeButton.setAttribute('data-active', this.flightPlanVisible ? 'true' : 'false');
        if (followButton) followButton.setAttribute('data-active', this.followAircraft ? 'true' : 'false');
      }

      setFollowAircraft(enabled, recenter) {
        this.followAircraft = !!enabled;
        this.updateControlStates();
        if (this.followAircraft && recenter && this.map) {
          const lat = getSimVar('PLANE LATITUDE', 'degrees');
          const lon = getSimVar('PLANE LONGITUDE', 'degrees');
          if (validLatLon(lat, lon)) {
            this.map.setView([lat, lon], this.map.getZoom(), { animate: false, reset: false });
            this.updateAircraftScreenPosition(lat, lon);
          }
        }
      }

      async setFlightPlanVisible(visible) {
        this.flightPlanVisible = !!visible;
        this.updateControlStates();
        
        if (this.flightPlanVisible) {
          // Tlačítko se zapnulo -> spustíme cyklus aktualizace a okamžitě stáhneme data
          this.startMapCycles();
          await this.reloadFixedFlightPlan(true);
        } else {
          // Tlačítko se vypnulo -> NATVRDO zastavíme interval, aby data na pozadí nestahoval
          if (this.routeTimer !== null) {
            window.clearInterval(this.routeTimer);
            this.routeTimer = null;
          }
          this.routeRefreshBusy = false;

          // Kompletně vymažeme data z paměti
          this.flightPlanWaypoints = [];
          this.flightPlanPoints = [];
          
          // Vynutíme smazání fialové čáry z mapy
          this.drawFlightPlan();
        }
      }

      async reloadFixedFlightPlan(drawAfterLoad) {
        const loadId = ++this.fixedPlanLoadId;
        try {
          console.log("[Simple Moving Map] Načítám trasu z MSFS 2024 EFB...");
          
          const route = await Coherent.call('GET_EFB_ROUTE');
          if (loadId !== this.fixedPlanLoadId) return;

          if (!route) {
            console.log("[Simple Moving Map] V EFB není aktivní žádná trasa.");
            this.flightPlanWaypoints = [];
            this.flightPlanPoints = [];
            return;
          }

          let parsed = [];
          let userIndex = 0;
          let unresolvedIcaos = [];
          let unresolvedIndices = [];

          // 1. POKUS: Zkusíme standardní legs z EFB
          let rawLegs = route.legs || route.waypoints || null;

          // 2. POKUS: Pokud EFB legs nedodalo, zkusíme si vytáhnout plně rozbalenou trasu přímo z herního manažeru letového plánu (Garmin/FMC)
          if (!Array.isArray(rawLegs) || rawLegs.length === 0) {
            try {
              const activeFlightPlan = await Coherent.call('GET_FLIGHTPLAN') || await Coherent.call('GET_ACTIVE_ROUTE');
              if (activeFlightPlan && Array.isArray(activeFlightPlan.legs)) {
                console.log("[Simple Moving Map] Trasa úspěšně synchronizována s herním FlightPlan manažerem.");
                rawLegs = activeFlightPlan.legs;
              }
            } catch (_) {
              // Herní FlightPlan API nemusí být u některých letadel přístupné
            }
          }

          if (Array.isArray(rawLegs) && rawLegs.length > 0) {
            console.log(`[Simple Moving Map] Nalezen kompletní seznam fází letu (${rawLegs.length} bodů).`);
            
            rawLegs.forEach(leg => {
              if (!leg) return;
              
              let lat = NaN;
              let lon = NaN;
              
              if (leg.hasLatLon && Number.isFinite(leg.lat) && leg.lat !== 0) {
                lat = Number(leg.lat);
                lon = Number(leg.lon);
              } else if (leg.worldPosition && Number.isFinite(leg.worldPosition.lat)) {
                lat = Number(leg.worldPosition.lat);
                lon = Number(leg.worldPosition.lon);
              } else if (Number.isFinite(leg.lat) && leg.lat !== 0) {
                lat = Number(leg.lat);
                lon = Number(leg.lon);
              }

              let wpName = leg.ident || (leg.fixIcao && leg.fixIcao.ident) ? (leg.ident || leg.fixIcao.ident).trim() : "WP" + (++userIndex);

              if (Number.isFinite(lat) && Number.isFinite(lon)) {
                parsed.push({ point: [lat, lon], name: wpName });
              } else if (leg.fixIcao && leg.fixIcao.ident) {
                unresolvedIcaos.push(leg.fixIcao);
                unresolvedIndices.push(parsed.length);
                parsed.push({ point: null, name: wpName });
              } else if (leg.icao && leg.icao.ident) {
                unresolvedIcaos.push(leg.icao);
                unresolvedIndices.push(parsed.length);
                parsed.push({ point: null, name: wpName });
              }
            });
          } else {
            // FALLBACK: Pokud selhal i pokus o přímý letový plán, složíme trasu z klasických tří základních částí EFB
            console.log("[Simple Moving Map] Kompletní seznam fází letu nedostupný v EFB ani v GPS. Skládám trasu z enroute segmentů...");
            
            // 1. Odletové letiště
            if (route.departureAirport && Number.isFinite(route.departureAirport.lat) && route.departureAirport.lat !== 0) {
              parsed.push({ point: [Number(route.departureAirport.lat), Number(route.departureAirport.lon)], name: route.departureAirport.ident || "DEP" });
            } else if (route.departureAirport && route.departureAirport.ident) {
              unresolvedIcaos.push(route.departureAirport);
              unresolvedIndices.push(parsed.length);
              parsed.push({ point: null, name: route.departureAirport.ident });
            }

            // 2. Traťové body (enroute)
            if (Array.isArray(route.enroute)) {
              route.enroute.forEach(leg => {
                if (!leg) return;
                let lat = leg.hasLatLon && leg.lat !== 0 ? Number(leg.lat) : (leg.worldPosition ? Number(leg.worldPosition.lat) : NaN);
                let lon = leg.hasLatLon && leg.lon !== 0 ? Number(leg.lon) : (leg.worldPosition ? Number(leg.worldPosition.lon) : NaN);
                let wpName = (leg.fixIcao && leg.fixIcao.ident) ? leg.fixIcao.ident.trim() : (leg.ident ? leg.ident.trim() : "WP" + (++userIndex));

                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                  parsed.push({ point: [lat, lon], name: wpName });
                } else if (leg.fixIcao && leg.fixIcao.ident) {
                  unresolvedIcaos.push(leg.fixIcao);
                  unresolvedIndices.push(parsed.length);
                  parsed.push({ point: null, name: wpName });
                }
              });
            }

            // 3. Příletové letiště
            if (route.destinationAirport && Number.isFinite(route.destinationAirport.lat) && route.destinationAirport.lat !== 0) {
              parsed.push({ point: [Number(route.destinationAirport.lat), Number(route.destinationAirport.lon)], name: route.destinationAirport.ident || "ARR" });
            } else if (route.destinationAirport && route.destinationAirport.ident) {
              unresolvedIcaos.push(route.destinationAirport);
              unresolvedIndices.push(parsed.length);
              parsed.push({ point: null, name: route.destinationAirport.ident });
            }
          }

          // --- ASYNCHRONNÍ VYHLEDÁNÍ CHYBĚJÍCÍCH SOUŘADNIC PŘES FACILITYLOADER ---
          if (unresolvedIcaos.length > 0) {
            console.log(`[Simple Moving Map] Vyhledávám souřadnice pro ${unresolvedIcaos.length} bodů přes FacilityLoader...`);
            const facilities = await this.loadFacilities(unresolvedIcaos);
            
            unresolvedIcaos.forEach((icao, index) => {
              const facility = facilities[index];
              const targetIndex = unresolvedIndices[index];
              
              if (facility && validLatLon(Number(facility.lat), Number(facility.lon))) {
                parsed[targetIndex].point = [Number(facility.lat), Number(facility.lon)];
                console.log(`[Simple Moving Map] Nalezen scházející bod: ${parsed[targetIndex].name} [${facility.lat}, ${facility.lon}]`);
              }
            });
          }

          // --- MATEMATICKY BEZPEČNÁ FILTRACE DUPLICIT A NEPLATNÝCH BODŮ ---
          let compact = [];
          parsed.forEach(item => {
            if (!item.point || !Array.isArray(item.point) || !Number.isFinite(item.point[0]) || !Number.isFinite(item.point[1])) {
              return; 
            }
            
            if (compact.length > 0) {
              const prev = compact[compact.length - 1];
              const diffLat = Math.abs(prev.point[0] - item.point[0]);
              const diffLon = Math.abs(prev.point[1] - item.point[1]);              
              if (diffLat < 0.0001 && diffLon < 0.0001) {
                return; 
              }
            }
            compact.push(item);
          });

          if (compact.length >= 2) {
            this.flightPlanWaypoints = compact;
            this.flightPlanPoints = compact.map(waypoint => waypoint.point);
            this.flightPlanSignature = 'dynamic_efb2024:' + loadId;
            this.flightPlanSource = 'MSFS_2024_EFB_Route';
            console.log(`[Simple Moving Map] Úspěšně vykresleno ${compact.length} bodů na mapě.`);
          } else {
            this.flightPlanWaypoints = [];
            this.flightPlanPoints = [];
          }

        } catch (error) {
          if (loadId !== this.fixedPlanLoadId) return;
          this.flightPlanWaypoints = [];
          this.flightPlanPoints = [];
          console.warn('[Simple Moving Map] Chyba při zpracování trasy:', error);
        }

        if (drawAfterLoad || this.flightPlanVisible) this.drawFlightPlan();
      }

      async parsePlnText(xmlText) {
        const doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('invalid PLN XML');
        const root = doc.getElementsByTagName('FlightPlan.FlightPlan')[0];
        if (!root) return [];
        const text = (node, tag) => {
          const found = node && node.getElementsByTagName(tag)[0];
          return found ? String(found.textContent || '').trim() : '';
        };
        const makeIcao = (ident, type, region, airport) => ident ? {
          __Type: 'JS_ICAO', type: type, region: region || '', airport: airport || '', ident: ident
        } : null;
        const departureId = text(root, 'DepartureID');
        const destinationId = text(root, 'DestinationID');
        const descriptors = [];
        if (departureId) descriptors.push({
          point: parseWorldPosition(text(root, 'DepartureLLA')),
          name: departureId,
          icao: makeIcao(departureId, 'A'),
          role: 'departure'
        });
        let userIndex = 0;
        Array.from(root.getElementsByTagName('ATCWaypoint')).forEach(node => {
          const kind = text(node, 'ATCWaypointType').toLowerCase();
          const ident = text(node, 'ICAOIdent');
          let name = ident || node.getAttribute('id') || text(node, 'Descr');
          if (kind === 'user' || !name || /^(custom|cust\d*)$/i.test(name)) name = 'WP' + (++userIndex);
          const type = kind === 'airport' ? 'A' : kind === 'vor' ? 'V' : kind === 'ndb' ? 'N' : 'W';
          descriptors.push({
            point: parseWorldPosition(text(node, 'WorldPosition')),
            name: name,
            icao: makeIcao(ident, type, text(node, 'ICAORegion'), text(node, 'ICAOAirport')),
            role: 'enroute'
          });
        });
        if (destinationId) descriptors.push({
          point: parseWorldPosition(text(root, 'DestinationLLA')),
          name: destinationId,
          icao: makeIcao(destinationId, 'A'),
          role: 'destination'
        });

        const compact = [];
        descriptors.forEach(item => {
          const previous = compact.length ? compact[compact.length - 1] : null;
          if (!previous || previous.name !== item.name) compact.push(item);
        });
        const unresolved = compact.filter(item => !item.point && item.icao);
        if (unresolved.length) {
          const facilities = await this.loadFacilities(unresolved.map(item => item.icao));
          unresolved.forEach((item, index) => {
            const facility = facilities[index];
            if (facility && validLatLon(Number(facility.lat), Number(facility.lon))) {
              item.point = [Number(facility.lat), Number(facility.lon)];
            }
          });
        }
        return compact.filter(item => item.point);
      }

      updateAircraftScreenPosition(latArg, lonArg) {
        const planeNode = this.planeRef && this.planeRef.instance;
        if (!planeNode || !this.map) return;

        const lat = Number.isFinite(latArg) ? latArg : getSimVar('PLANE LATITUDE', 'degrees');
        const lon = Number.isFinite(lonArg) ? lonArg : getSimVar('PLANE LONGITUDE', 'degrees');
        if (!validLatLon(lat, lon)) return;

        try {
          const p = this.map.latLngToContainerPoint([lat, lon]);
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
            planeNode.style.left = p.x.toFixed(1) + 'px';
            planeNode.style.top = p.y.toFixed(1) + 'px';
          }
        } catch (_) {}
      }

      isIcaoPresent(icao) {
        if (!icao || typeof icao !== 'object') return false;
        return !!(
          (typeof icao.ident === 'string' && icao.ident.trim())
          || (typeof icao.airport === 'string' && icao.airport.trim())
          || (typeof icao.region === 'string' && icao.region.trim())
          || (typeof icao.type === 'string' && icao.type.trim())
        );
      }

      async loadFacilities(icaos) {
        const results = [];

        if (this.facilityLoader && typeof this.facilityLoader.awaitInitialization === 'function') {
          try { await this.facilityLoader.awaitInitialization(); } catch (_) {}
        }

        for (const icao of icaos) {
          let facility = null;

          // Resolve one ICAO at a time. This is slower than a batch but is much
          // more robust across current MSFS 2024 EFB/instrument contexts.
          if (this.facilityLoader && typeof this.facilityLoader.getFacilities === 'function') {
            try {
              const one = await this.facilityLoader.getFacilities([icao], 0);
              facility = Array.isArray(one) ? (one[0] || null) : null;
            } catch (_) {}
          }

          // Direct airport fallback, important for simple VFR A-to-B routes.
          if (!facility && icao && icao.type === 'A') {
            try { facility = await this.loadAirportFallback(icao); } catch (_) {}
          }

          results.push(facility);
        }

        return results;
      }

      async resolveFlightPlanPoints(route) {
        if (!route) return [];

        const descriptors = [];
        const facilityIcaos = [];

        const addFacilityDescriptor = (icao, extra) => {
          if (!this.isIcaoPresent(icao)) return;
          const facilityIndex = facilityIcaos.length;
          facilityIcaos.push(icao);
          descriptors.push(Object.assign({ kind: 'facility', facilityIndex }, extra || {}));
        };

        addFacilityDescriptor(route.departureAirport, { role: 'departure' });

        const legs = Array.isArray(route.enroute) ? route.enroute : [];
        for (const leg of legs) {
          if (!leg) continue;

          if (leg.isPpos) {
            const lat = getSimVar('PLANE LATITUDE', 'degrees');
            const lon = getSimVar('PLANE LONGITUDE', 'degrees');
            if (validLatLon(lat, lon)) descriptors.push({ kind: 'coord', point: [lat, lon] });
            continue;
          }

          if (leg.hasLatLon && validLatLon(Number(leg.lat), Number(leg.lon))) {
            descriptors.push({ kind: 'coord', point: [Number(leg.lat), Number(leg.lon)] });
            continue;
          }

          if (leg.hasPointBearingDistance && this.isIcaoPresent(leg.referenceIcao)) {
            addFacilityDescriptor(leg.referenceIcao, {
              role: 'pbd',
              bearing: Number(leg.bearing),
              distance: Number(leg.distance)
            });
            continue;
          }

          if (this.isIcaoPresent(leg.fixIcao)) {
            addFacilityDescriptor(leg.fixIcao, { role: 'enroute' });
            continue;
          }

          // Some simulator builds may populate lat/lon even when hasLatLon is false.
          if (validLatLon(Number(leg.lat), Number(leg.lon))) {
            descriptors.push({ kind: 'coord', point: [Number(leg.lat), Number(leg.lon)] });
          }
        }

        addFacilityDescriptor(route.destinationAirport, { role: 'destination' });

        const facilities = await this.loadFacilities(facilityIcaos);
        const points = [];

        for (const descriptor of descriptors) {
          let point = null;

          if (descriptor.kind === 'coord') {
            point = descriptor.point;
          } else {
            const facility = facilities[descriptor.facilityIndex];
            if (facility && validLatLon(Number(facility.lat), Number(facility.lon))) {
              if (descriptor.role === 'pbd') {
                point = destinationPoint(
                  Number(facility.lat),
                  Number(facility.lon),
                  descriptor.bearing,
                  descriptor.distance
                );
              } else {
                point = [Number(facility.lat), Number(facility.lon)];
              }
            }
          }

          if (point && validLatLon(point[0], point[1])) {
            const previous = points.length ? points[points.length - 1] : null;
            if (!previous || Math.abs(previous[0] - point[0]) > 1e-7 || Math.abs(previous[1] - point[1]) > 1e-7) {
              points.push(point);
            }
          }
        }

        return points;
      }

      async applyFlightPlanRoute(route) {
        try {
          this.lastFlightPlanRoute = route;
          const points = await this.resolveFlightPlanPoints(route);
          const signature = points.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join('|');
          if (signature === this.flightPlanSignature) return;
          this.flightPlanSignature = signature;
          this.flightPlanPoints = points;
          this.drawFlightPlan();
        } catch (e) {
          console.warn('[Simple Moving Map] Could not resolve EFB route:', e);
        }
      }

      drawFlightPlan() {
        if (!this.map || !window.L) return;

        // 1. KROK: Okamžitě smažeme starou trasu i popisky z mapy, pokud existují
        if (this.flightPlanLayer) {
          try { this.map.removeLayer(this.flightPlanLayer); } catch (_) {}
          this.flightPlanLayer = null;
        }
        if (this.flightPlanLabelLayer) {
          try { this.map.removeLayer(this.flightPlanLabelLayer); } catch (_) {}
          this.flightPlanLabelLayer = null;
        }

        // --- HARDWAROVÝ RESET CANVASU PRO COHERENT GT ---
        // Pokud se má trasa skrýt, natvrdo zničíme celý panel a vymažeme cache grafické karty
        if (!this.flightPlanVisible || !Array.isArray(this.flightPlanPoints) || this.flightPlanPoints.length < 2) {
          const oldPane = this.map.getPane('simple-route-pane');
          if (oldPane && oldPane.parentNode) {
            try {
              // Odstraníme starý panel z DOMu, což vymaže fialové artefakty v rozích
              oldPane.parentNode.removeChild(oldPane); 
            } catch (_) {}
          }
          // Vytvoříme okamžitě nový čistý panel pro příští zapnutí trasy
          const newPane = this.map.createPane('simple-route-pane');
          newPane.style.zIndex = '450';
          newPane.style.pointerEvents = 'none';
          if (typeof window.L.canvas === 'function') {
            this.flightPlanRenderer = window.L.canvas({ pane: 'simple-route-pane', padding: 0.5 });
          }
          return; // Bezpečně končíme, mapa je dokonale čistá
        }

        // 2. KROK: Samotné vykreslení čáry pomocí rychlého Canvasu
        this.flightPlanLayer = window.L.polyline(this.flightPlanPoints, {
          color: '#d400ff',
          weight: 5,
          opacity: 1,
          pane: 'simple-route-pane',
          renderer: this.flightPlanRenderer || undefined, // Použije náš Canvas renderer
          interactive: false,
          lineJoin: 'round',
          lineCap: 'round'
        }).addTo(this.map);

        // Vykreslení horizontálních štítků
        if (Array.isArray(this.flightPlanWaypoints) && window.L.divIcon && window.L.marker && window.L.layerGroup) {
          const labels = this.flightPlanWaypoints.map(waypoint => window.L.marker(waypoint.point, {
            interactive: false,
            icon: window.L.divIcon({
              className: 'simple-waypoint-label-wrap',
              html: '<span class="simple-waypoint-label">' + String(waypoint.name).replace(/[&<>"']/g, '') + '</span>',
              iconSize: null,
              iconAnchor: [0, 0]
            })
          }));
          this.flightPlanLabelLayer = window.L.layerGroup(labels).addTo(this.map);
        }
      }

/*
      drawFlightPlan() {
        if (!this.map || !window.L) return;

        // 1. KROK: Okamžitě smažeme starou trasu i popisky z mapy, pokud existují
        if (this.flightPlanLayer) {
          try { this.map.removeLayer(this.flightPlanLayer); } catch (_) {}
          this.flightPlanLayer = null;
        }
        if (this.flightPlanLabelLayer) {
          try { this.map.removeLayer(this.flightPlanLabelLayer); } catch (_) {}
          this.flightPlanLabelLayer = null;
        }

        // 2. KROK: Teprve TEĎ zkontrolujeme, zda máme trasu vykreslit. 
        // Pokud je vypnutá nebo prázdná, bezpečně skončíme (mapa už je čistá!)
        if (!this.flightPlanVisible || !Array.isArray(this.flightPlanPoints) || this.flightPlanPoints.length < 2) {
          return;
        }

        // 3. KROK: Samotné vykreslení čéru na čisté plátno
        this.flightPlanLayer = window.L.polyline(this.flightPlanPoints, {
          color: '#d400ff',
          weight: 5,
          opacity: 1,
          pane: 'simple-route-pane',
          renderer: this.flightPlanRenderer || undefined,
          interactive: false,
          lineJoin: 'round',
          lineCap: 'round'
        }).addTo(this.map);

        if (Array.isArray(this.flightPlanWaypoints) && window.L.divIcon && window.L.marker && window.L.layerGroup) {
          const labels = this.flightPlanWaypoints.map(waypoint => window.L.marker(waypoint.point, {
            interactive: false,
            icon: window.L.divIcon({
              className: 'simple-waypoint-label-wrap',
              html: '<span class="simple-waypoint-label">' + String(waypoint.name).replace(/[&<>"']/g, '') + '</span>',
              iconSize: null,
              iconAnchor: [0,0]
            })
          }));
          this.flightPlanLabelLayer = window.L.layerGroup(labels).addTo(this.map);
        }
      }
*/

      getVisibleViewport() {
        const root = this.rootRef.instance;
        const mapNode = this.mapRef.instance;
        if (!root || !mapNode) return null;

        // Prefer the EFB window dimensions. Fall back to the app root/parent.
        const doc = document.documentElement;
        const body = document.body;
        const parent = root.parentElement;
        const grandParent = parent && parent.parentElement;
        const parentRect = parent && parent.getBoundingClientRect ? parent.getBoundingClientRect() : null;
        const grandRect = grandParent && grandParent.getBoundingClientRect ? grandParent.getBoundingClientRect() : null;

        // Prefer the EFB host/app content surface. Only use the full Coherent
        // window as a last resort. This keeps the app inside MSFS's tablet frame.
        const candidates = [
          [parentRect && parentRect.width, parentRect && parentRect.height],
          [parent && parent.clientWidth, parent && parent.clientHeight],
          [grandRect && grandRect.width, grandRect && grandRect.height],
          [grandParent && grandParent.clientWidth, grandParent && grandParent.clientHeight],
          [root.clientWidth, root.clientHeight],
          [body && body.clientWidth, body && body.clientHeight],
          [doc && doc.clientWidth, doc && doc.clientHeight],
          [window.innerWidth, window.innerHeight]
        ];

        for (const pair of candidates) {
          const w = Math.round(Number(pair[0]) || 0);
          const h = Math.round(Number(pair[1]) || 0);
          if (w > 200 && h > 200) return { width: w, height: h };
        }
        return null;
      }

      ensureViewport(force) {
        if (this.destroyed) return;
        const root = this.rootRef.instance;
        const mapNode = this.mapRef.instance;
        if (!root || !mapNode) return;

        const vp = this.getVisibleViewport();
        if (!vp) return; // app is probably hidden

        // Do not trust percentage sizing after MSFS swaps EFB pages. Give Leaflet
        // an explicit pixel viewport matching the currently visible EFB surface.
        root.style.width = vp.width + 'px';
        root.style.height = vp.height + 'px';
        root.style.minWidth = '0';
        root.style.minHeight = '0';
        mapNode.style.width = vp.width + 'px';
        mapNode.style.height = vp.height + 'px';
        mapNode.style.minWidth = '0';
        mapNode.style.minHeight = '0';

        const changed = Math.abs(vp.width - this.lastViewportWidth) > 2 ||
                        Math.abs(vp.height - this.lastViewportHeight) > 2;
        this.lastViewportWidth = vp.width;
        this.lastViewportHeight = vp.height;

        if (!this.map) {
          const lat = getSimVar('PLANE LATITUDE', 'degrees');
          const lon = getSimVar('PLANE LONGITUDE', 'degrees');
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            this.createMap(lat, lon, this.lastGoodZoom);
          } else {
            return;
          }
        }

        if (force || changed) {
          try {
            // Force Leaflet to throw away the size it cached while this app was hidden.
            this.map._sizeChanged = true;
            this.map.invalidateSize({ animate: false, pan: false, debounceMoveend: false });
          } catch (_) {}
          this.syncPosition(true);
        }

        // Detect the exact failure seen in MSFS: the EFB surface is large but
        // Leaflet thinks its viewport is only a small corner. Recreate the map
        // instance if invalidation did not repair it.
        let leafletSize = null;
        try { leafletSize = this.map.getSize(); } catch (_) {}
        const badSize = !leafletSize ||
          leafletSize.x < vp.width * 0.75 ||
          leafletSize.y < vp.height * 0.75;

        if (badSize && !this.rebuildPending) {
          this.rebuildPending = true;
          window.setTimeout(() => {
            if (this.destroyed) return;
            const currentVp = this.getVisibleViewport();
            const lat = getSimVar('PLANE LATITUDE', 'degrees');
            const lon = getSimVar('PLANE LONGITUDE', 'degrees');
            if (currentVp && Number.isFinite(lat) && Number.isFinite(lon)) {
              this.createMap(lat, lon, this.lastGoodZoom);
              try {
                this.map._sizeChanged = true;
                this.map.invalidateSize({ animate: false, pan: false });
              } catch (_) {}
              this.syncPosition(true);
            }
            this.rebuildPending = false;
          }, 80);
        }
      }

      updateAircraftHeading(force) {
        const planeNode = this.planeRef && this.planeRef.instance;
        if (!planeNode) return;

        // North-up map: true heading is the correct rotation reference.
        let heading = getSimVar('PLANE HEADING DEGREES TRUE', 'degrees');
        if (!Number.isFinite(heading)) {
          heading = getSimVar('PLANE HEADING DEGREES MAGNETIC', 'degrees');
        }
        if (!Number.isFinite(heading)) return;

        heading = ((heading % 360) + 360) % 360;

        if (!force && Number.isFinite(this.lastHeading)) {
          let delta = Math.abs(heading - this.lastHeading);
          delta = Math.min(delta, 360 - delta);
          if (delta < 0.1) return;
        }

        this.lastHeading = heading;
        planeNode.style.transform =
          'translate(-50%, -50%) rotate(' + heading.toFixed(2) + 'deg)';
        planeNode.style.transformOrigin = '50% 50%';
      }

      syncPosition(force) {
        if (this.destroyed || !this.map) return;
        this.updateAircraftHeading(force);
        const lat = getSimVar('PLANE LATITUDE', 'degrees');
        const lon = getSimVar('PLANE LONGITUDE', 'degrees');
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const samePosition = Number.isFinite(this.lastLat) && Number.isFinite(this.lastLon) &&
          Math.abs(lat - this.lastLat) < 0.000001 && Math.abs(lon - this.lastLon) < 0.000001;

        this.lastLat = lat;
        this.lastLon = lon;
        this.lastGoodZoom = this.map.getZoom();
        this.sessionZoom = this.lastGoodZoom;

        if (this.followAircraft && (force || !samePosition)) {
          this.map.setView([lat, lon], this.lastGoodZoom, { animate: false, reset: false });
        }

        // In follow mode this resolves to the center. When the user pans, the
        // symbol moves across the map at the aircraft's real geographic position.
        this.updateAircraftScreenPosition(lat, lon);
      }

      onOpen() {
        if (this.map && Number.isFinite(this.sessionZoom)) {
          try { this.map.setZoom(this.sessionZoom, { animate: false }); } catch (_) {}
        }
        this.updateAircraftHeading(true);
        this.updateControlStates();
        this.drawFlightPlan();
	this.startMapCycles(); // Zapne časovače a okamžitě překreslí mapu
      }
      onResume() { this.onOpen(); }
      onPause() {
        if (this.map) {
          try {
            this.sessionZoom = this.map.getZoom();
            this.lastGoodZoom = this.sessionZoom;
          } catch (_) {}
        }
	this.stopMapCycles();  // Zastaví veškerou aktivitu na pozadí, když mapa není vidět
      }
      onClose() { this.onPause(); }
      onUpdate() {}

      destroy() {
        this.destroyed = true;
	this.stopMapCycles(); // Bezpečně zastaví všechny intervaly
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.mutationObserver) this.mutationObserver.disconnect();
        if (this._simpleResizeHandler) window.removeEventListener('resize', this._simpleResizeHandler);
        if (this._mapWheelHandler && this.mapRef && this.mapRef.instance) {
          try { this.mapRef.instance.removeEventListener('wheel', this._mapWheelHandler); } catch (_) {}
          this._mapWheelHandler = null;
        }
        if (this.map) {
          this.map.remove();
          this.map = null;
        }
        super.destroy();
      }

      render() {
        const h = sdk.FSComponent.buildComponent;
        return h('div', { class: 'simple-moving-map', ref: this.rootRef },
          h('div', { class: 'simple-leaflet-map', ref: this.mapRef }),
          h('div', { class: 'simple-aircraft', ref: this.planeRef, 'aria-hidden': 'true' },
            h('svg', { viewBox: '0 0 64 64', role: 'img' },
              h('path', { d: 'M32 3c-2.4 0-4.2 2-4.2 4.5v17.1L7.5 36.2v6.2l20.3-6v13.2l-7.2 5.3v4.1L32 56l11.4 3v-4.1l-7.2-5.3V36.4l20.3 6v-6.2L36.2 24.6V7.5C36.2 5 34.4 3 32 3z' })
            )
          ),
          h('div', { class: 'simple-zoom' },
            h('button', { type: 'button', 'data-map-action': 'zoom-in', 'aria-label': 'Zoom in' }, '+'),
            h('button', { type: 'button', 'data-map-action': 'zoom-out', 'aria-label': 'Zoom out' },
              h('svg', { class: 'simple-minus-icon', viewBox: '0 0 32 32', 'aria-hidden': 'true' },
                h('path', { d: 'M7 16h18' })
              )
            )
          ),
          h('div', { class: 'simple-map-tools' },
            h('button', { type: 'button', 'data-map-action': 'follow-toggle', 'data-active': 'true', 'aria-label': 'Follow aircraft', title: 'Follow aircraft' },
              h('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' },
                h('circle', { cx: '16', cy: '16', r: '8' }),
                h('path', { d: 'M16 2v5M16 25v5M2 16h5M25 16h5' })
              )
            ),
            h('button', { type: 'button', 'data-map-action': 'route-toggle', 'data-active': 'false', 'aria-label': 'Show or hide flight plan', title: 'Show/hide flight plan' },
              h('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' },
                h('circle', { cx: '6', cy: '24', r: '3' }),
                h('circle', { cx: '16', cy: '8', r: '3' }),
                h('circle', { cx: '27', cy: '20', r: '3' }),
                h('path', { d: 'M8 21l6-10M19 10l6 8' })
              )
            )
          ),
          h('div', { class: 'simple-attribution' }, '© OpenTopoMap · © OpenStreetMap contributors')
        );
      }
    };
  }

  function register() {
    const sdk = getSdk();
    const efb = window.EFB_API;
    if (!sdk || !efb || typeof efb.use !== 'function') return false;

    const View = makeViewClass(sdk);

    class SimpleMovingMapApp {
      constructor() {
        this.available = sdk.Subject.create(true);
        this.BootMode = 0;
        this.SuspendMode = 0;
        this._isReady = false;
        this._favoriteIndex = -1;
        this.bus = null;
      }

      get name() { return APP_NAME; }
      get internalName() { return INTERNAL_NAME; }
      get icon() { return `${BASE_URL}/Assets/app-icon.svg`; }
      get isReady() { return this._isReady; }
      get favoriteIndex() { return this._favoriteIndex; }
      set favoriteIndex(value) { this._favoriteIndex = value; }
      get compatibleAircraftModels() { return undefined; }
      getIsSearchable() { return true; }
      getIsFavoritable() { return true; }
      getVersion() { return VERSION; }

      async install() {
        // User-editable tile provider configuration. It is a local JS config file
        // instead of fetched JSON so it remains reliable in Coherent GT.
        try {
          await loadPlainScriptOnce(`${BASE_URL}/MapConfig.js`);
        } catch (e) {
          console.warn('[Simple Moving Map] MapConfig.js could not be loaded; using defaults.', e);
        }

        // Bundle Leaflet locally exactly as working aircraft tablet implementations do.
        loadCssOnce(`${BASE_URL}/lib/leaflet/leaflet.css`);
        if (typeof efb.loadCss === 'function') efb.loadCss(`${BASE_URL}/SimpleMovingMap.css`);
        else loadCssOnce(`${BASE_URL}/SimpleMovingMap.css`);
        await loadScriptOnce(`${BASE_URL}/lib/leaflet/leaflet.js`);
      }

      async _install(props) {
        this.bus = props && props.bus;
        this.unitsSettingManager = props && props.unitsSettingManager;
        this.notificationManager = props && props.notificationManager;
        this.efbSettingsManager = props && props.efbSettingsManager;
        this.options = props && props.options;
        await this.install(props);
        this._isReady = true;
        try {
          if (window.Coherent && typeof window.Coherent.trigger === 'function') {
            window.Coherent.trigger('EFB_APP_INSTALLED', this.internalName, true);
          }
        } catch (_) {}
      }

      render() {
//       return sdk.FSComponent.buildComponent(View, { bus: this.bus });
         return sdk.FSComponent.buildComponent(View, { bus: this.bus, sdk: sdk }); // <--- Přidáno sdk: sdk
      }
    }

    efb.use(SimpleMovingMapApp);
    return true;
  }

  let tries = 0;
  const retry = window.setInterval(() => {
    tries += 1;
    if (register() || tries > 200) window.clearInterval(retry);
  }, 50);
})();
