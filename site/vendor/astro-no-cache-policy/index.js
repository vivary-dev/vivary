// Astro 7.3.5 uses only these two methods to decide a remote image's TTL.
// This policy does not retain requests or responses or grant freshness.
export default class NoCachePolicy {
  storable() {
    return false;
  }

  timeToLive() {
    return 0;
  }
}
