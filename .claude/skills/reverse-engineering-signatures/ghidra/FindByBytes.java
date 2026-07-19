// Ghidra Java post-script: find the CONTAINING FUNCTION ENTRY for each occurrence of a
// byte sequence anywhere in executable memory. Unlike FindEntry (which takes a known
// RVA), this scans for a fingerprint you can't yet place, then reports the function
// entry + arity for each hit. Use when a hook's caller-context sig broke and you need
// to locate the target function by an in-body fingerprint instead.
//
// Args: one or more space-separated byte tokens forming ONE pattern, hex, '?' = wildcard.
//   -postScript FindByBytes.java "c5 fa 2e 86 80 00 00 00"
// (quote the whole pattern as a single arg).
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;
import java.util.ArrayList;
import java.util.List;

public class FindByBytes extends GhidraScript {
    long baseOff;
    FunctionManager fm;
    long rva(Address a) { return a.getOffset() - baseOff; }

    // parse "aa bb ? dd" into value[] + mask[] (mask false = wildcard)
    int[] vals; boolean[] mask;
    void parsePattern(String s) {
        String[] toks = s.trim().split("\\s+");
        vals = new int[toks.length];
        mask = new boolean[toks.length];
        for (int i = 0; i < toks.length; i++) {
            if (toks[i].equals("?") || toks[i].equals("??")) { mask[i] = false; vals[i] = 0; }
            else { mask[i] = true; vals[i] = Integer.parseInt(toks[i], 16) & 0xff; }
        }
    }

    List<Address> scan() throws Exception {
        List<Address> hits = new ArrayList<>();
        int n = vals.length;
        for (MemoryBlock b : currentProgram.getMemory().getBlocks()) {
            if (!b.isExecute()) continue;
            long size = b.getEnd().getOffset() - b.getStart().getOffset() + 1;
            byte[] buf = new byte[(int) size];
            try { currentProgram.getMemory().getBytes(b.getStart(), buf); } catch (Exception e) { continue; }
            for (int i = 0; i + n <= buf.length; i++) {
                boolean ok = true;
                for (int j = 0; j < n; j++) {
                    if (mask[j] && (buf[i + j] & 0xff) != vals[j]) { ok = false; break; }
                }
                if (ok) hits.add(b.getStart().add(i));
            }
        }
        return hits;
    }

    String bytesHex(Address a, int n) {
        try { byte[] bb = new byte[n]; currentProgram.getMemory().getBytes(a, bb);
            StringBuilder sb = new StringBuilder();
            for (byte x : bb) sb.append(String.format("%02x ", x & 0xff));
            return sb.toString().trim();
        } catch (Exception e) { return "<unreadable>"; }
    }

    void report(Address hit) {
        // widen disasm window so the containing function is defined
        DisassembleCommand dc = new DisassembleCommand(
            new AddressSet(hit.subtract(Math.min(rva(hit), 0x2500)), hit.add(0x200)), null, true);
        dc.applyTo(currentProgram, monitor);
        Function fn = fm.getFunctionContaining(hit);
        if (fn == null) {
            println("   hit rva=0x" + Long.toHexString(rva(hit)) + " -> no containing fn");
            return;
        }
        Address e = fn.getEntryPoint();
        println("   hit rva=0x" + Long.toHexString(rva(hit)) +
                "  ENTRY rva=0x" + Long.toHexString(rva(e)) +
                "  params=" + fn.getParameterCount());
        println("       entry: " + bytesHex(e, 20));
    }

    @Override
    public void run() throws Exception {
        baseOff = currentProgram.getImageBase().getOffset();
        fm = currentProgram.getFunctionManager();
        String[] a = getScriptArgs();
        if (a == null || a.length == 0) { println("need a byte-pattern arg"); return; }
        String pat = String.join(" ", a);
        parsePattern(pat);
        println("=== FindByBytes: " + pat + "  (base 0x" + Long.toHexString(baseOff) + ") ===");
        List<Address> hits = scan();
        println("  " + hits.size() + " hit(s)");
        int shown = 0;
        for (Address h : hits) { report(h); if (++shown >= 30) { println("   ..."); break; } }
        println("=== done ===");
    }
}
