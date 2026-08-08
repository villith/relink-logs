//! Damage-cap ORACLE. Verification only — never compiled into a release hook.
//!
//! Records the game's own per-term cap contributions so the pure reproduction
//! in `src-tauri/src/parser/v1/cap/` can be diffed against ground truth. The
//! reproduction is what ships; this exists to prove it right.
//!
//! Gated behind [`BuildGuard`]: the chokepoint it detours serves EVERY
//! parameter query in the game, and recording unconditionally is not
//! affordable on the game thread.

thread_local! {
    /// The DamageInstance currently being built on this thread, or `None`.
    ///
    /// Save/restore rather than set/clear, for the same reason `sba.rs`'s
    /// `HitGuard` does it: builds nest, and clearing on drop would erase the
    /// enclosing build and stop recording for the rest of it.
    ///
    /// All access goes through `try_with`, so a call during thread teardown
    /// degrades to "nothing armed" instead of panicking inside the game.
    static BUILDING: std::cell::Cell<Option<*const usize>> =
        const { std::cell::Cell::new(None) };

    /// Terms recorded during the current build, in call order:
    /// `(descriptor_vtable_rva, param_id, value)`.
    static TERMS: std::cell::RefCell<Vec<(u32, i32, f32)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Arms recording for the duration of one DamageInstance build.
pub(crate) struct BuildGuard(Option<*const usize>);

impl BuildGuard {
    pub(crate) fn arm(damage_instance: *const usize) -> Self {
        BuildGuard(
            BUILDING
                .try_with(|c| c.replace(Some(damage_instance)))
                .unwrap_or(None),
        )
    }

    pub(crate) fn current() -> Option<*const usize> {
        BUILDING.try_with(|c| c.get()).ok().flatten()
    }
}

impl Drop for BuildGuard {
    fn drop(&mut self) {
        let _ = BUILDING.try_with(|c| c.set(self.0));
    }
}

/// Records one contribution. A no-op when nothing is armed, which is the
/// common case — the chokepoint serves the whole game.
pub(crate) fn record_term(descriptor_vtable_rva: u32, param_id: i32, value: f32) {
    if BuildGuard::current().is_none() {
        return;
    }
    let _ = TERMS.try_with(|t| {
        t.borrow_mut()
            .push((descriptor_vtable_rva, param_id, value))
    });
}

/// Drains the recorded terms, leaving the buffer clean for the next build.
pub(crate) fn take_terms() -> Vec<(u32, i32, f32)> {
    TERMS
        .try_with(|t| std::mem::take(&mut *t.borrow_mut()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arming_restores_the_previous_frame_on_drop() {
        assert_eq!(BuildGuard::current(), None);
        let outer = BuildGuard::arm(0x1000 as *const usize);
        assert_eq!(BuildGuard::current(), Some(0x1000 as *const usize));
        {
            let inner = BuildGuard::arm(0x2000 as *const usize);
            assert_eq!(BuildGuard::current(), Some(0x2000 as *const usize));
            drop(inner);
        }
        // The enclosing build must survive the nested one — a clear-on-drop
        // here would silently stop recording for the rest of the outer build.
        assert_eq!(BuildGuard::current(), Some(0x1000 as *const usize));
        drop(outer);
        assert_eq!(BuildGuard::current(), None);
    }

    #[test]
    fn recording_is_ignored_when_nothing_is_armed() {
        assert_eq!(BuildGuard::current(), None);
        record_term(0xdead, 2, 1.5);
        assert!(take_terms().is_empty());
    }

    #[test]
    fn recorded_terms_come_back_in_call_order() {
        let _armed = BuildGuard::arm(0x1000 as *const usize);
        record_term(0xaaa, 2, 1.5);
        record_term(0xbbb, 0x22, 0.25);
        assert_eq!(take_terms(), vec![(0xaaa, 2, 1.5), (0xbbb, 0x22, 0.25)]);
        // Taking drains, so the next build starts clean.
        assert!(take_terms().is_empty());
    }
}
