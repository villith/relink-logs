// Ghidra Java post-script: inspect a function at a given RVA to confirm identity
// before hooking. Reports: callers (xrefs to entry), callees, referenced strings,
// and a linear disassembly of the first N instructions. Used to confirm 0x3f1330
// is the quest result-screen handler (not some generic dispatcher) and to read its
// argument usage.
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.RefType;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;

public class InspectFunc extends GhidraScript {
    long baseOff;
    int DISASM_LEN = 70; // instructions to disassemble per function; override with len=<N>
    long rva(Address a) { return a.getOffset() - baseOff; }
    Address atRva(long r) { return currentProgram.getImageBase().add(r); }

    @Override
    public void run() throws Exception {
        baseOff = currentProgram.getImageBase().getOffset();
        FunctionManager fm = currentProgram.getFunctionManager();
        Listing listing = currentProgram.getListing();
        ReferenceManager rm = currentProgram.getReferenceManager();

        // Target function-entry RVAs come from script args (hex), e.g.
        //   -postScript InspectFunc.java 0x3f1330 0x63ecb0
        // Falls back to a known example if none given.
        // Args: hex RVAs to inspect, optionally followed by "len=<N>" to set disasm depth.
        String[] argv = getScriptArgs();
        java.util.List<Long> tlist = new java.util.ArrayList<>();
        if (argv != null) {
            for (String s : argv) {
                s = s.trim();
                // "L<N>" (e.g. L180) sets disasm depth; Ghidra splits on '=', so avoid it.
                if (s.startsWith("L") || s.startsWith("l")) { DISASM_LEN = Integer.parseInt(s.substring(1)); continue; }
                tlist.add(Long.parseLong(s.replaceFirst("^0x", ""), 16));
            }
        }
        long[] targets;
        if (!tlist.isEmpty()) {
            targets = new long[tlist.size()];
            for (int i = 0; i < tlist.size(); i++) targets[i] = tlist.get(i);
        } else {
            targets = new long[] { 0x63ecb0L };
        }
        for (long trva : targets) {
            Address entry = atRva(trva);
            // ensure disassembled + function exists (widen window to cover whole fn)
            DisassembleCommand dc = new DisassembleCommand(
                new AddressSet(atRva(trva), atRva(trva + 0x600)), null, true);
            dc.applyTo(currentProgram, monitor);
            Function fn = fm.getFunctionContaining(entry);
            if (fn == null) {
                new CreateFunctionCmd(entry).applyTo(currentProgram, monitor);
                fn = fm.getFunctionContaining(entry);
            }
            println("=== FUNC rva=0x" + Long.toHexString(trva) + " ===");
            if (fn != null) {
                println("  name=" + fn.getName() + " entry=0x" + Long.toHexString(rva(fn.getEntryPoint()))
                        + " body=" + fn.getBody().getNumAddresses() + " bytes");
            }

            // Callers: references TO the entry point
            println("  -- CALLERS (xrefs to entry) --");
            int cc = 0;
            for (Reference r : rm.getReferencesTo(entry)) {
                RefType rt = r.getReferenceType();
                println("    from 0x" + Long.toHexString(r.getFromAddress().getOffset() - baseOff)
                        + " (" + rt + ")");
                if (++cc >= 20) { println("    ..."); break; }
            }
            if (cc == 0) println("    (none found — may be virtual/vtable-dispatched)");

            // Linear disasm of first ~60 instructions, flag calls + string refs
            println("  -- DISASM (first 70 instrs; calls & data refs flagged) --");
            Instruction ins = listing.getInstructionAt(entry);
            int n = 0;
            while (ins != null && n < DISASM_LEN) {
                StringBuilder line = new StringBuilder();
                line.append("    0x").append(Long.toHexString(rva(ins.getAddress())))
                    .append("  ").append(ins.toString());
                // flag call targets
                Address[] flows = ins.getFlows();
                if (ins.getMnemonicString().toLowerCase().startsWith("call") && flows.length > 0) {
                    for (Address f : flows) {
                        Function tf = fm.getFunctionContaining(f);
                        line.append("   -> 0x").append(Long.toHexString(f.getOffset() - baseOff));
                        if (tf != null) line.append(" (").append(tf.getName()).append(")");
                    }
                }
                // flag referenced data (possible strings)
                for (Reference r : ins.getReferencesFrom()) {
                    if (r.getReferenceType().isData()) {
                        Address to = r.getToAddress();
                        String s = null;
                        try {
                            byte[] bb = new byte[64];
                            currentProgram.getMemory().getBytes(to, bb);
                            StringBuilder sv = new StringBuilder();
                            for (byte x : bb) {
                                int v = x & 0xff;
                                if (v == 0) break;
                                if (v >= 0x20 && v < 0x7f) sv.append((char) v); else { sv.setLength(0); break; }
                            }
                            if (sv.length() >= 4) s = sv.toString();
                        } catch (Exception e) {}
                        if (s != null) line.append("   str=\"").append(s).append("\"");
                    }
                }
                println(line.toString());
                ins = ins.getNext();
                n++;
            }
        }
        println("=== done ===");
    }
}
