// For each given FUNCTION ENTRY rva, list the defined-string references inside
// the function body. THE attribution query for "which character/entity owns
// this code" — per-character code carries tag strings ("pl0400", "em1200",
// "ab_scourge_vanish"). Companion to CallSiteArgsMulti: that gives the
// constants, this names the code that passes them.
//
//   -postScript FnStrings.java <fnEntryRva> [<fnEntryRva> ...]
//
// Output: STR|<fn_entry>|<fn_name>|string1;string2;...   (strings deduped,
// commas replaced by ';' so downstream CSV parsing stays simple)
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.symbol.Reference;
import java.util.LinkedHashSet;
import java.util.Set;

public class FnStrings extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            println("usage: FnStrings <fnEntryRva> [<fnEntryRva> ...]");
            return;
        }
        long base = currentProgram.getImageBase().getOffset();
        for (String a : args) {
            Address entry = toAddr(base + Long.decode(a));
            Function fn = getFunctionAt(entry);
            if (fn == null) fn = getFunctionContaining(entry);
            if (fn == null) {
                println("STR|" + a + "|(none)|");
                continue;
            }
            Set<String> strs = new LinkedHashSet<>();
            Instruction ins = getInstructionAt(fn.getEntryPoint());
            while (ins != null && fn.getBody().contains(ins.getAddress())) {
                for (Reference r : ins.getReferencesFrom()) {
                    Data d = getDataAt(r.getToAddress());
                    if (d != null && d.hasStringValue()) {
                        String s = d.getValue().toString();
                        if (s.length() >= 3 && s.length() <= 80) {
                            strs.add(s.replace(",", ";").replace("|", "/"));
                        }
                    }
                }
                ins = ins.getNext();
            }
            println("STR|" + a + "|" + fn.getName() + "|" + String.join(";", strs));
        }
    }
}
