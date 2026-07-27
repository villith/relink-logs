// Given a target function RVA, find every call/reference site to it and print
// the few instructions preceding each site (reveals argument setup like
// `MOV EDX, <slot>` that the decompiler elides). Usage:
//   -postScript DisasmCalls.java <targetRva> [<onlyWithinEntryRva> ...]
// If onlyWithinEntryRva values are given, only sites inside those functions
// are printed.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import java.util.HashSet;
import java.util.Set;

public class DisasmCalls extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            println("usage: DisasmCalls <targetRva> [<onlyWithinEntryRva> ...]");
            return;
        }
        long base = currentProgram.getImageBase().getOffset();
        Address target = toAddr(base + Long.decode(args[0]));
        Set<Long> filter = new HashSet<>();
        for (int i = 1; i < args.length; i++) filter.add(base + Long.decode(args[i]));

        println("=== DisasmCalls target 0x" + Long.toHexString(target.getOffset() - base) + " ===");
        ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(target);
        int shown = 0;
        while (it.hasNext() && !monitor.isCancelled()) {
            Reference ref = it.next();
            Address from = ref.getFromAddress();
            Function fn = getFunctionContaining(from);
            if (!filter.isEmpty()) {
                if (fn == null) continue;
                if (!filter.contains(fn.getEntryPoint().getOffset())) continue;
            }
            Instruction ins = getInstructionAt(from);
            if (ins == null) continue;
            String fnName = fn == null ? "(none)" : fn.getName() + "@0x"
                    + Long.toHexString(fn.getEntryPoint().getOffset() - base);
            println("--- site rva=0x" + Long.toHexString(from.getOffset() - base) + " in " + fnName);
            // walk back 8 instructions
            Instruction cur = ins;
            Instruction[] back = new Instruction[8];
            int n = 0;
            for (int i = 0; i < 8; i++) {
                Instruction prev = cur.getPrevious();
                if (prev == null) break;
                back[n++] = prev;
                cur = prev;
            }
            for (int i = n - 1; i >= 0; i--) {
                println("      0x" + Long.toHexString(back[i].getAddress().getOffset() - base)
                        + "  " + back[i].toString());
            }
            println("   >  0x" + Long.toHexString(from.getOffset() - base) + "  " + ins.toString());
            shown++;
        }
        println("=== done, " + shown + " site(s) ===");
    }
}
