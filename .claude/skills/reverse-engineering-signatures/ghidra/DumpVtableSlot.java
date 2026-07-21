// Ghidra Java post-script: for every `<Name>::vftable` symbol whose class name matches
// a substring, print the function pointer stored at a given slot offset. Use it to find
// which subclasses OVERRIDE a virtual and which inherit the base implementation — the
// question you have to answer before hooking a virtual, since one detour per override
// is needed. Run against the ANALYZED DB (gbfr202fast); the lean import has no RTTI.
//
// Args: <class-name-substring> <slot-offset-hex>, e.g.:
//   -postScript DumpVtableSlot.java Status 0x48
//
// Output: one line per vtable, grouped counts at the end. Filter with:
//   grep 'DumpVtableSlot.java>'
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import java.util.LinkedHashMap;
import java.util.Map;

public class DumpVtableSlot extends GhidraScript {
    long baseOff;
    long rva(long addrOffset) { return addrOffset - baseOff; }

    @Override
    public void run() throws Exception {
        baseOff = currentProgram.getImageBase().getOffset();
        String[] args = getScriptArgs();
        if (args == null || args.length < 2) { println("args: <class-substring> <slot-hex>"); return; }
        String needle = args[0].toLowerCase();
        long slot = Long.parseLong(args[1].trim().toLowerCase().replaceFirst("^0x", ""), 16);
        Memory mem = currentProgram.getMemory();

        println("=== DumpVtableSlot: class~\"" + args[0] + "\" slot +0x" + Long.toHexString(slot) + " ===");
        Map<Long, Integer> tally = new LinkedHashMap<>();
        int rows = 0;
        SymbolIterator it = currentProgram.getSymbolTable().getAllSymbols(true);
        while (it.hasNext()) {
            Symbol s = it.next();
            String name = s.getName(true);
            if (!name.endsWith("::vftable")) continue;
            String cls = name.substring(0, name.length() - "::vftable".length());
            if (!cls.toLowerCase().contains(needle)) continue;
            Address slotAddr = s.getAddress().add(slot);
            long target;
            try {
                target = mem.getLong(slotAddr);
            } catch (Exception e) {
                println("  " + cls + "  <unreadable slot>");
                continue;
            }
            if (target == 0) continue;
            long targetRva = rva(target);
            println("  0x" + Long.toHexString(targetRva) + "  " + cls);
            tally.merge(targetRva, 1, Integer::sum);
            rows++;
        }
        println("--- " + rows + " vtable(s), " + tally.size() + " distinct target(s):");
        for (Map.Entry<Long, Integer> e : tally.entrySet()) {
            println("    0x" + Long.toHexString(e.getKey()) + "  x" + e.getValue());
        }
        println("=== done ===");
    }
}
