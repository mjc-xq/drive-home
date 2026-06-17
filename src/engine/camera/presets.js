// Camera presets — pure data, imported by both the camera/drive code and the controls
// (driveTopDown reads DRIVE_CAMS[camMode].dragdrive). Keeping these a dependency-free LEAF is
// what lets controls and the drive camera both import them without an import cycle.

export const DRIVE_CAMS = [
  // order = 🎥 cycle order. Cruise (clean high chase) is the default; Close (low,
  // cinematic, gets the full whip+roll) is now SECOND so the most speed-rich view is
  // one tap away; Top-down (drag-to-drive) third; Aerial (Explore orbit) last.
  // Cruise leans a little lower/more-forward than before for speed feel, but stays
  // high enough to clear the melty ground-level photogrammetry (the user's preferred
  // clean look — NOT the low 'eye-level horror' of Close).
  { name: 'Cruise', dist: 14, h: 22, ahead: 6, drone: true, topdown: false, side: 0.42 },   // side = a 3/4 hero angle: above and to the SIDE/behind, not dead astern
  { name: 'Close', dist: 19, h: 12.5, ahead: 12, drone: false, topdown: false },   // Roblox chase: sit back + look well down the road so you SEE where you're going (not just the roof of the car)
  { name: 'Top-down', dist: 10, h: 122, ahead: 16, drone: true, topdown: true, dragdrive: true },   // higher overhead map view
  { name: 'Aerial', aerial: true, dragdrive: true },   // the Explore look (high orbit), drag to drive there
];

// Scoop camera presets [dist, height] — cycled with the 🎥 button.
// Roblox-style follow cams. The DEFAULT (index 0) is a behind-the-shoulder angled view like
// Roblox's default camera — so a right-side swipe orbits AROUND the keeper and you actually see
// the world turn, instead of just spinning a top-down map. 'Overhead' is kept for precise
// scooping (it reads the poops better from straight above). pitch (vertical look) raises/lowers
// the height; pinch (szoom) is the distance dolly.
export const SCOOP_CAMS = [
  { name: 'Follow', dist: 13, h: 8 },      // ~32° down: over-the-shoulder, the Roblox default
  { name: 'Angled', dist: 14, h: 15 },     // ~47° down: tilts past the melty horizon to the yard
  { name: 'Overhead', dist: 10, h: 19 },   // ~62° down: near top-down for precise scooping
];
