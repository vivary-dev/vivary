// Astro 7.4.2 uses only these two methods to decide a remote image's TTL.
// This policy does not retain requests or responses or grant freshness.
export default class NoCachePolicy {
  storable() {
    return false;
  }

  timeToLive() {
    return 0;
  }
}
