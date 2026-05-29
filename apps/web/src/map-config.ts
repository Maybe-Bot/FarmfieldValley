/**
 * Basemap definitions used by the Leaflet map.
 *
 * Keeping tile URLs here makes it easier to switch imagery providers later
 * without rewriting map components.
 */
export const basemaps = {
  worldLight: {
    key: "worldLight",
    name: "World Light",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  },
  usAerial: {
    key: "usAerial",
    name: "US Aerial Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      'Powered by <a href="https://www.esri.com">Esri</a> | Sources: Esri, Maxar, Earthstar Geographics, USDA FSA, USGS, Aerogrid, IGN, and the GIS User Community'
  }
};
