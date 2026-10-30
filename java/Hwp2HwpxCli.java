import kr.dogfoot.hwp2hwpx.Hwp2Hwpx;
import kr.dogfoot.hwplib.reader.HWPReader;
import kr.dogfoot.hwpxlib.writer.HWPXWriter;

public class Hwp2HwpxCli {
    public static void main(String[] args) {
        if (args.length != 2) {
            System.err.println("Usage: Hwp2HwpxCli <in.hwp> <out.hwpx>");
            System.exit(2);
        }
        try {
            HWPXWriter.toFilepath(Hwp2Hwpx.toHWPX(HWPReader.fromFile(args[0])), args[1]);
        } catch (Exception e) {
            e.printStackTrace(System.err);
            System.exit(1);
        }
    }
}
