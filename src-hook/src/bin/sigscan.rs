//! Standalone signature-validation harness for re-deriving AOB patterns after a
//! game patch (e.g. the 2.0.2 Endless Ragnarok expansion broke every signature).
//!
//! It maps the on-disk `granblue_fantasy_relink.exe` with pelite and runs the SAME
//! pelite pattern scan the hook uses (`scanner.matches_code`), but reports:
//!   * how many times the pattern matches (we want exactly 1 for a good sig), and
//!   * for each match, the captured cursor RVA and the u32/u8 value there (for
//!     offset sigs) or the followed call target RVA (for function sigs).
//!
//! Usage:
//!   cargo run -p hook --bin sigscan -- "<pelite pattern>" [slice_u32|slice_u8|addr]
//!   cargo run -p hook --bin sigscan -- dumprva <hexrva> [len]
//!
//! The exe path is read from the GBFR_EXE env var, falling back to the known
//! Steam library path on this machine.
use std::env;

use pelite::pattern;
use pelite::pe64::{Pe, PeFile};

const DEFAULT_EXE: &str =
    r"G:\SteamLibrary\steamapps\common\Granblue Fantasy Relink\granblue_fantasy_relink.exe";

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: sigscan \"<pattern>\" [slice_u32|slice_u8|addr]");
        eprintln!("       sigscan dumprva <hexrva> [len]");
        std::process::exit(2);
    }
    let pat_str = &args[1];
    let mode = args.get(2).map(|s| s.as_str()).unwrap_or("slice_u32");

    let exe_path = env::var("GBFR_EXE").unwrap_or_else(|_| DEFAULT_EXE.to_string());
    let file_bytes = std::fs::read(exe_path).expect("could not read game exe");
    let pe = PeFile::from_bytes(&file_bytes).expect("could not parse PE");

    // `dumprva <hexrva> [len]` — dump bytes at an RVA via pelite (correct addressing),
    // used to inspect a hook target's function-entry prologue.
    if pat_str == "dumprva" {
        let rva_str = args.get(2).expect("need rva");
        let rva = u32::from_str_radix(rva_str.trim_start_matches("0x"), 16).expect("bad rva");
        let len: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(64);
        match pe.derva_slice::<u8>(rva, len) {
            Ok(b) => println!("rva 0x{rva:x} ({len} bytes): {}", hex(b)),
            Err(e) => println!("unreadable rva 0x{rva:x}: {e:?}"),
        }
        return;
    }

    let pattern = pattern::parse(pat_str).expect("could not parse pattern");
    let scanner = pe.scanner();

    let mut matches = scanner.matches_code(&pattern);
    let mut addrs = [0u32; 8];
    let mut count = 0usize;

    println!("pattern: {}", pat_str);
    println!("mode:    {}", mode);
    // Cap only the verbose per-match dump; keep counting every match so `total matches` and
    // the uniqueness WARNING below are accurate even for a very non-unique pattern.
    const MAX_DUMP: usize = 32;
    while matches.next(&mut addrs) {
        count += 1;
        if count == MAX_DUMP + 1 {
            println!("  ... (further matches not dumped; still counting)");
        }
        if count <= MAX_DUMP {
            let cursor_rva = addrs[1];
            print!("  match #{count}: match_rva=0x{:x} cursor_rva=0x{:x}", addrs[0], cursor_rva);
            // Dump 24 bytes BEFORE and 48 bytes starting at the match, to aid re-derivation
            // (function sigs often need the caller context that precedes the anchor).
            if addrs[0] >= 24 {
                if let Ok(pre) = pe.derva_slice::<u8>(addrs[0] - 24, 24) {
                    print!("\n    pre: {}", hex(pre));
                }
            }
            if let Ok(ctx) = pe.derva_slice::<u8>(addrs[0], 48) {
                print!("\n    at:  {}", hex(ctx));
            }
            match mode {
                "slice_u32" => match read_u32_at_rva(&pe, cursor_rva) {
                    Some(v) => print!("  value(u32)=0x{v:x} ({v})"),
                    None => print!("  value(u32)=<unreadable>"),
                },
                "slice_u8" => match read_u8_at_rva(&pe, cursor_rva) {
                    Some(v) => print!("  value(u8)=0x{v:x} ({v})"),
                    None => print!("  value(u8)=<unreadable>"),
                },
                "addr" => {
                    // For addr mode the cursor already holds the followed/resolved RVA.
                    print!("  target_rva=0x{cursor_rva:x}");
                }
                other => print!("  <unknown mode {other}>"),
            }
            println!();
        }
    }

    println!("total matches: {count}");
    if count == 0 {
        std::process::exit(1);
    }
    if count > 1 {
        eprintln!("WARNING: pattern is not unique ({count} matches) — narrow it before use");
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn read_u32_at_rva(pe: &PeFile, rva: u32) -> Option<u32> {
    let bytes = pe.derva_slice::<u8>(rva, 4).ok()?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_u8_at_rva(pe: &PeFile, rva: u32) -> Option<u8> {
    let bytes = pe.derva_slice::<u8>(rva, 1).ok()?;
    Some(bytes[0])
}
