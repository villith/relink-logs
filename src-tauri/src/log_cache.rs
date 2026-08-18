//! A small, bounded cache of decoded logs, keyed by log id.
//!
//! `fetch_encounter_state` is called on every pin, regroup, tab, side swap,
//! scrub commit and filter chip in the Analysis view, and every one of those
//! calls used to start from `SELECT data ... WHERE id = ?` and rebuild the whole
//! encounter: a zstd decompress, a bincode deserialise of the entire raw event
//! log, and the spawn segmentation over it. None of that work depends on what
//! was clicked — it is the same for every request against one log — so it is
//! done once and kept here.
//!
//! Generic over the value so the eviction rules can be tested without standing
//! up a `Parser`; `main.rs` instantiates it at the one type it holds.
//!
//! Entries are handed out as `Arc<Mutex<V>>` rather than by value. Two panes can
//! be reading one log, and the cached value is *reused in place* rather than
//! cloned — the reparse resets the derived state it writes, so successive
//! requests can share one decoded encounter, but only one at a time.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// A bounded, least-recently-used cache.
///
/// A `Vec` rather than a map plus a list: the capacity is a handful of entries
/// (a comparison holds two logs, and someone flicking between runs a few more),
/// so a linear scan is faster than the bookkeeping a real LRU needs, and it
/// keeps the eviction order something you can read off the code.
pub struct LogCache<V> {
    capacity: usize,
    /// Least-recently-used FIRST, most-recently-used LAST.
    entries: Vec<(u64, Arc<Mutex<V>>)>,
    /// Bumped by [`Self::clear`]. A decode runs with no lock held (see
    /// [`Self::insert`]'s doc), so it can straddle a clear; comparing the
    /// generation from before and after is how [`Self::insert_if_current`]
    /// notices and refuses to resurrect what the clear was meant to drop.
    generation: AtomicU64,
}

impl<V> LogCache<V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: Vec::new(),
            generation: AtomicU64::new(0),
        }
    }

    /// A token for what [`Self::clear`] has dropped so far. Unrelated to any
    /// one id — it exists to be captured before an unlocked decode and
    /// compared after, in [`Self::insert_if_current`].
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    /// The cached value for `id`, marking it most-recently-used.
    pub fn get(&mut self, id: u64) -> Option<Arc<Mutex<V>>> {
        let at = self.entries.iter().position(|(held, _)| *held == id)?;
        let entry = self.entries.remove(at);
        let handle = Arc::clone(&entry.1);
        self.entries.push(entry);
        Some(handle)
    }

    /// Store `value` under `id` and return the handle to use.
    ///
    /// An id already present keeps the handle it has, and the value passed here
    /// is DROPPED. Two requests for a log not yet cached can both miss and both
    /// decode it — the load deliberately runs without the cache locked, since it
    /// reads the database — and handing the second one its own handle would give
    /// the two panes separate copies of one log, each reparsing the other's work
    /// away. They decoded the same bytes, so keeping the first costs nothing.
    ///
    /// Use [`Self::invalidate`] to actually replace an entry.
    pub fn insert(&mut self, id: u64, value: V) -> Arc<Mutex<V>> {
        if let Some(existing) = self.get(id) {
            return existing;
        }
        let handle = Arc::new(Mutex::new(value));
        self.entries.push((id, Arc::clone(&handle)));
        // AFTER the push, and a loop rather than a single drop: a capacity of
        // zero has to evict what was just added, and a capacity lowered between
        // calls would otherwise strand every entry above the new one.
        while self.entries.len() > self.capacity {
            self.entries.remove(0);
        }
        handle
    }

    /// Like [`Self::insert`], but discarded rather than stored if `at_generation`
    /// no longer matches [`Self::generation`] — a [`Self::clear`] landed during
    /// the unlocked decode that produced `value`, so it is handed back for the
    /// caller to use but not kept where a later request would find it.
    pub fn insert_if_current(&mut self, id: u64, value: V, at_generation: u64) -> Arc<Mutex<V>> {
        if self.generation() != at_generation {
            return Arc::new(Mutex::new(value));
        }
        self.insert(id, value)
    }

    /// Forget one log. A handle already taken stays alive and usable — whoever
    /// holds it is mid-request — it simply stops being handed out.
    pub fn invalidate(&mut self, id: u64) {
        self.entries.retain(|(held, _)| *held != id);
    }

    /// Forget everything. What the log-store writes call: a delete, an import or
    /// a newly recorded encounter can move any id, and no cache is worth showing
    /// a stale fight under a live title.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ids held, least-recently-used first.
    fn held<V>(cache: &LogCache<V>) -> Vec<u64> {
        cache.entries.iter().map(|(id, _)| *id).collect()
    }

    #[test]
    fn a_log_that_was_never_decoded_is_a_miss() {
        let mut cache: LogCache<String> = LogCache::new(2);
        assert!(cache.get(2657).is_none());
    }

    #[test]
    fn a_decoded_log_is_handed_back() {
        let mut cache = LogCache::new(2);
        cache.insert(2657, String::from("fight"));

        let held = cache.get(2657).expect("just inserted");
        assert_eq!(*held.lock().unwrap(), "fight");
    }

    /// The point of the handle: two requests for one log share ONE decoded
    /// encounter, so what the second does to it the first can see. A copy each
    /// would mean each reparsing the other's work away.
    #[test]
    fn two_readers_of_one_log_share_it() {
        let mut cache = LogCache::new(2);
        let first = cache.insert(2657, String::from("fight"));
        let second = cache.get(2657).expect("cached");

        *first.lock().unwrap() = String::from("reparsed");

        assert_eq!(*second.lock().unwrap(), "reparsed");
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn a_full_cache_drops_the_least_recently_used() {
        let mut cache = LogCache::new(2);
        cache.insert(1, ());
        cache.insert(2, ());
        cache.insert(3, ());

        assert_eq!(held(&cache), vec![2, 3]);
        assert!(cache.get(1).is_none());
    }

    /// Reading a log is what keeps it: flicking between two runs must not evict
    /// the one being flicked back to.
    #[test]
    fn reading_a_log_saves_it_from_the_next_eviction() {
        let mut cache = LogCache::new(2);
        cache.insert(1, ());
        cache.insert(2, ());
        cache.get(1);
        cache.insert(3, ());

        assert_eq!(held(&cache), vec![1, 3]);
        assert!(cache.get(2).is_none());
    }

    #[test]
    fn re_inserting_a_cached_log_keeps_the_handle_already_in_use() {
        let mut cache = LogCache::new(2);
        let first = cache.insert(2657, String::from("fight"));
        let second = cache.insert(2657, String::from("decoded again"));

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(*second.lock().unwrap(), "fight");
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn re_inserting_a_cached_log_also_marks_it_used() {
        let mut cache = LogCache::new(2);
        cache.insert(1, ());
        cache.insert(2, ());
        cache.insert(1, ());
        cache.insert(3, ());

        assert_eq!(held(&cache), vec![1, 3]);
    }

    #[test]
    fn invalidating_forgets_one_log_and_leaves_the_rest() {
        let mut cache = LogCache::new(4);
        cache.insert(1, ());
        cache.insert(2, ());
        cache.invalidate(1);

        assert!(cache.get(1).is_none());
        assert!(cache.get(2).is_some());
    }

    #[test]
    fn invalidating_a_log_nobody_cached_changes_nothing() {
        let mut cache = LogCache::new(4);
        cache.insert(1, ());
        cache.invalidate(999);

        assert_eq!(held(&cache), vec![1]);
    }

    /// A handle taken before the invalidation belongs to a request that is
    /// mid-flight. Dropping it out of the cache must not break it.
    #[test]
    fn a_handle_already_taken_survives_its_invalidation() {
        let mut cache = LogCache::new(2);
        let taken = cache.insert(2657, String::from("fight"));
        cache.invalidate(2657);

        assert_eq!(*taken.lock().unwrap(), "fight");
    }

    #[test]
    fn clearing_forgets_everything() {
        let mut cache = LogCache::new(4);
        cache.insert(1, ());
        cache.insert(2, ());
        cache.clear();

        assert!(cache.is_empty());
        assert!(cache.get(1).is_none());
    }

    /// A capacity of zero is "do not cache" and must not panic or, worse, keep
    /// one entry anyway.
    #[test]
    fn a_capacity_of_zero_stores_nothing() {
        let mut cache = LogCache::new(0);
        let handle = cache.insert(2657, String::from("fight"));

        assert!(cache.is_empty());
        assert!(cache.get(2657).is_none());
        // The caller still gets a usable value — it simply is not kept.
        assert_eq!(*handle.lock().unwrap(), "fight");
    }

    #[test]
    fn clearing_bumps_the_generation() {
        let mut cache: LogCache<()> = LogCache::new(2);
        let generation = cache.generation();
        cache.clear();

        assert_ne!(cache.generation(), generation);
    }

    #[test]
    fn reading_or_inserting_does_not_bump_the_generation() {
        let mut cache = LogCache::new(2);
        let generation = cache.generation();
        cache.insert(1, ());
        cache.get(1);
        cache.invalidate(1);

        assert_eq!(cache.generation(), generation);
    }

    /// The race `insert_if_current` exists for: a decode starts, a delete/import
    /// clears the cache before it finishes, and the decode's result must not
    /// resurrect an entry the clear was meant to drop.
    #[test]
    fn a_decode_racing_a_clear_is_handed_back_but_not_cached() {
        let mut cache: LogCache<String> = LogCache::new(2);
        let generation = cache.generation();

        cache.clear();

        let handle = cache.insert_if_current(2657, String::from("stale"), generation);

        assert_eq!(*handle.lock().unwrap(), "stale");
        assert!(cache.get(2657).is_none());
    }

    #[test]
    fn insert_if_current_behaves_like_insert_when_nothing_raced_it() {
        let mut cache = LogCache::new(2);
        let generation = cache.generation();

        let handle = cache.insert_if_current(2657, String::from("fresh"), generation);

        assert_eq!(*handle.lock().unwrap(), "fresh");
        assert!(cache.get(2657).is_some());
    }
}
