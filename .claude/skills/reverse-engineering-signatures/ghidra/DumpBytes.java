// Ghidra Java post-script: hex-dump raw program bytes at the given RVA(s). The
// bridge for "what did the OLD exe's code look like around this site" when the
// old exe file itself is gone (Steam patched in place) but its Ghidra DB persists.
// Pair with XrefsTo.java: xref site RVA -> DumpBytes -> build a sigscan pattern
// (wildcard the disp32) -> scan the NEW exe -> read the new disp -> new RVA.
//
// Args: one or more rva[:len] (hex rva, decimal len, default 96), e.g.:
//   -postScript DumpBytes.java 0x1b0dd80:64 0x3f1330
//
// Output: one line per arg. Filter with: grep 'DumpBytes.java>'
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;

public class DumpBytes extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args == null || args.length == 0) { println("need rva[:len] arg(s)"); return; }
        for (String s : args) {
            String[] parts = s.split(":");
            long rva = Long.parseLong(parts[0].replaceFirst("^0[xX]", ""), 16);
            int len = parts.length > 1 ? Integer.parseInt(parts[1]) : 96;
            Address addr = currentProgram.getImageBase().add(rva);
            byte[] bytes = new byte[len];
            currentProgram.getMemory().getBytes(addr, bytes);
            StringBuilder sb = new StringBuilder();
            for (byte b : bytes) sb.append(String.format("%02x ", b));
            println(String.format("rva=0x%x len=%d: %s", rva, len, sb.toString().trim()));
        }
        println("=== done ===");
    }
}
