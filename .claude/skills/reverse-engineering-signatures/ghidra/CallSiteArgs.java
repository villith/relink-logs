// For every CALL site of a target function, report the last immediate written
// to each x64 argument location before the call: RCX/RDX/R8/R9 (args 1-4) and
// the stack slots [RSP+0x20]..[RSP+0x38] (args 5+). Answers "which constants
// does each caller pass?" — the query the decompiler hides when it drops an
// argument from a recovered signature.
//
//   -postScript CallSiteArgs.java <targetRva> [backWindow]
//
// Output (one line per site, CSV after the tag):
//   ARGS|site_rva,fn_entry,fn_name,rcx,rdx,r8,r9,s20,s28,s30,s38
// A cell is the immediate (0x..), "reg:NAME" when the value came from another
// register, or "?" when nothing was found inside the window.
//
// CRITICAL: "?" and "reg:" mean UNKNOWN, never "absent". A register-sourced
// argument may still be a compile-time constant stored earlier or loaded from
// a field — resolve those with the decompiler, not by assuming.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import java.util.LinkedHashMap;
import java.util.Map;

public class CallSiteArgs extends GhidraScript {
    private static final String[] SLOTS = {
        "RCX", "RDX", "R8", "R9", "[RSP + 0x20]", "[RSP + 0x28]", "[RSP + 0x30]", "[RSP + 0x38]"
    };

    /** Does this instruction write `slot`, and if so with what? */
    private String writeTo(Instruction ins, String slot) {
        String t = ins.toString();
        if (slot.startsWith("[")) {
            String p = "MOV dword ptr " + slot + ",";
            if (t.startsWith(p)) return t.substring(p.length());
            return null;
        }
        // 32-bit form is what compilers emit for int args (ECX for RCX, R8D for R8).
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
            println("usage: CallSiteArgs <targetRva> [backWindow]");
            return;
        }
        long base = currentProgram.getImageBase().getOffset();
        Address target = toAddr(base + Long.decode(args[0]));
        int window = args.length > 1 ? Integer.parseInt(args[1]) : 40;

        println("ARGS|site_rva,fn_entry,fn_name,rcx,rdx,r8,r9,s20,s28,s30,s38");
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
            for (int i = 0; i < window && found.size() < SLOTS.length; i++) {
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
        println("=== done, " + shown + " site(s) ===");
    }
}
