import kr.dogfoot.hwplib.reader.HWPReader;
import kr.dogfoot.hwplib.tool.textextractor.TextExtractor;
import kr.dogfoot.hwplib.tool.textextractor.TextExtractMethod;

class ExtractText {
    public static void main(String[] args) throws Exception {
        System.out.print(TextExtractor.extract(HWPReader.fromFile(args[0]), TextExtractMethod.InsertControlTextBetweenParagraphText));
    }
}
