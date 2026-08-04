// Multi-target CallSiteArgs: same per-site argument-slot report, but for MANY
// target functions in one headless run (JVM startup dominates single-target
// runs, and a family sweep has dozens of wrappers).
//
//   -postScript CallSiteArgsMulti.java <targetRva> [<targetRva> ...]
//
// Output per target:
//   === CallSiteArgs <rva> ===
//   ARGS|site_rva,fn_entry,fn_name,rcx,rdx,r8,r9,s20,s28,s30,s38,s40,s48,s50,s58
//   ARGS|...
//   === done <rva>, N site(s) ===
// Tracks 12 slots (through [RSP+0x58]) because this family passes the cause as
// deep as positional arg 10 (FUN_140bd0510).
// Cell semantics identical to CallSiteArgs.java: immediate (0x..), "reg:NAME",
// or "?" — and "?"/"reg:" mean UNKNOWN, never "absent" (resolve with the
// decompiler). Back-window is fixed at 40 instructions.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import java.util.LinkedHashMap;
import java.util.Map;

public class CallSiteArgsMulti extends GhidraScript {
    private static final String[] SLOTS = {
        "RCX", "RDX", "R8", "R9", "[RSP + 0x20]", "[RSP + 0x28]", "[RSP + 0x30]", "[RSP + 0x38]",
        "[RSP + 0x40]", "[RSP + 0x48]", "[RSP + 0x50]", "[RSP + 0x58]"
    };
    private static final int WINDOW = 40;

    private String writeTo(Instruction ins, String slot) {
        String t = ins.toString();
        if (slot.startsWith("[")) {
            String p = "MOV dword ptr " + slot + ",";
            if (t.startsWith(p)) return t.substring(p.length());
            return null;
        }
        String r32 = slot.startsWith("R") && Character.isDigit(slot.charAt(1))
                ? slot + "D" : "E" + slot.substring(1);
        if (t.equals("XOR " + r32 + "," + r32)) return "0x0";
        for (String reg : new String[] {r32, slot}) {
            String p = "MOV " + reg + ",";
            if (t.startsWith(p)) return t.substring(p.length());
            String lea = "LEA " + reg + ",";
            if (t.startsWith(lea)) return "lea:" + t.substring(lea.length());
        }
        return null;
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            println("usage: CallSiteArgsMulti <targetRva> [<targetRva> ...]");
            return;
        }
        long base = currentProgram.getImageBase().getOffset();
        for (String a : args) {
            Address target = toAddr(base + Long.decode(a));
            println("=== CallSiteArgs " + a + " ===");
            println("ARGS|site_rva,fn_entry,fn_name,rcx,rdx,r8,r9,s20,s28,s30,s38,s40,s48,s50,s58");
            int shown = 0;
            ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(target);
            while (it.hasNext() && !monitor.isCancelled()) {
                Reference ref = it.next();
                if (!ref.getReferenceType().isCall()) continue;
                Address from = ref.getFromAddress();
                Instruction ins = getInstructionAt(from);
                if (ins == null) continue;
                Function fn = getFunctionContaining(from);

                Map<String, String> found = new LinkedHashMap<>();
                Instruction cur = ins;
                for (int i = 0; i < WINDOW && found.size() < SLOTS.length; i++) {
                    cur = cur.getPrevious();
                    if (cur == null) break;
                    for (String slot : SLOTS) {
                        if (found.containsKey(slot)) continue;
                        String v = writeTo(cur, slot);
                        if (v != null) found.put(slot, v.replace(",", ";"));
                    }
                }
                StringBuilder sb = new StringBuilder();
                sb.append("ARGS|0x").append(Long.toHexString(from.getOffset() - base)).append(',')
                  .append(fn == null ? "0x0" : "0x" + Long.toHexString(
                          fn.getEntryPoint().getOffset() - base)).append(',')
                  .append(fn == null ? "(none)" : fn.getName());
                for (String slot : SLOTS) sb.append(',').append(found.getOrDefault(slot, "?"));
                println(sb.toString());
                shown++;
            }
            println("=== done " + a + ", " + shown + " site(s) ===");
        }
    }
}
