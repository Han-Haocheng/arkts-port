package io.legado.app.feature.reader.core.layout

import io.legado.app.feature.reader.core.model.ReaderPage
import io.legado.app.feature.reader.core.model.ReaderTextStyle

/**
 * 分页基准数据生成器：构造确定性的“已测量 block”，跑 ReaderPaginator，输出每页文本指纹。
 * 同一份场景在 ArkTS 侧重放，逐页比对即得到转写保真度。
 */
object Main {
    private val style = ReaderTextStyle(colorArgb = 0xff111111.toInt(), fontSizePx = 10f)

    private fun textBlock(
        text: String,
        widths: FloatArray,
        position: Int = 0,
        indent: Int = 0,
        alignment: ReaderTextAlignment = ReaderTextAlignment.START,
        lineHeightPx: Float = 20f,
        letterSpacingPx: Float? = null,
    ): ReaderMeasuredBlock.InlineParagraph {
        var offset = 0
        val items = text.mapIndexed { index, ch ->
            ReaderMeasuredInlineItem.Text(
                value = ch.toString(),
                widthPx = widths[index],
                style = style,
                chapterPosition = position + offset,
            ).also { offset += 1 }
        }
        return ReaderMeasuredBlock.InlineParagraph(
            items = items,
            indentCharacters = indent,
            alignment = alignment,
            lineHeightPx = lineHeightPx,
            baselineOffsetPx = 15f,
            baseTextSizePx = 10f,
            letterSpacingPx = letterSpacingPx,
        )
    }

    private fun uniform(text: String, width: Float = 20f): FloatArray = FloatArray(text.length) { width }

    private fun config(
        chapterIndex: Int = 0,
        viewportWidthPx: Int = 40,
        viewportHeightPx: Int = 45,
        paddingBottomPx: Float = 5f,
        paragraphSpacingPx: Float = 0f,
        columnCount: Int = 1,
    ) = ReaderPaginationConfig(
        chapterIndex = chapterIndex,
        chapterTitle = "标题",
        viewportWidthPx = viewportWidthPx,
        viewportHeightPx = viewportHeightPx,
        paddingLeftPx = 0f,
        paddingTopPx = 0f,
        paddingRightPx = 0f,
        paddingBottomPx = paddingBottomPx,
        lineHeightPx = 20f,
        baselineOffsetPx = 15f,
        paragraphSpacingPx = paragraphSpacingPx,
        columnCount = columnCount,
    )

    private fun esc(s: String): String {
        val sb = StringBuilder()
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c.code < 0x20) sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        return sb.toString()
    }

    private fun run(name: String, blocks: List<ReaderMeasuredBlock>, cfg: ReaderPaginationConfig): String {
        val pages: List<ReaderPage> = ReaderPaginator.paginateBlocks(blocks, cfg)
        val sb = StringBuilder()
        sb.append("{\"scenario\":\"").append(name).append("\",\"pageCount\":").append(pages.size).append(",\"pages\":[")
        pages.forEachIndexed { i, p ->
            if (i > 0) sb.append(',')
            sb.append("{\"pageIndex\":").append(p.id.pageIndex)
            sb.append(",\"text\":\"").append(esc(p.text)).append('"')
            sb.append(",\"elements\":").append(p.elements.size)
            sb.append(",\"heightPx\":").append(p.heightPx)
            sb.append(",\"scrollExtentPx\":").append(p.scrollExtentPx)
            sb.append('}')
        }
        sb.append("]}")
        return sb.toString()
    }

    @JvmStatic
    fun main(args: Array<String>) {
        val out = ArrayList<String>()

        // s1：中文均匀宽度，2 字/行、2 行/页
        out.add(run("s1_cn_basic", listOf(textBlock("一二三四五六七八九十", uniform("一二三四五六七八九十"))), config()))

        // s2：中文标点（句号、逗号），检验避头尾
        val s2 = "天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。"
        out.add(run("s2_cn_punct", listOf(textBlock(s2, uniform(s2))), config()))

        // s3：英文按空格折行，字母 8px、空格 5px
        val s3 = "the quick brown fox jumps over lazy dog"
        val w3 = FloatArray(s3.length) { if (s3[it] == ' ') 5f else 8f }
        out.add(run("s3_en_words", listOf(textBlock(s3, w3)), config()))

        // s4：两段 + 段间距
        val p4 = "第一段文字内容比较长一些"
        out.add(run(
            "s4_para_spacing",
            listOf(textBlock(p4, uniform(p4), position = 0), textBlock(p4, uniform(p4), position = p4.length)),
            config(paragraphSpacingPx = 6f),
        ))

        // s5：首行缩进 2 字
        val p5 = "缩进测试文字内容一二三四五六"
        out.add(run("s5_indent", listOf(textBlock(p5, uniform(p5), indent = 2)), config()))

        // s6：居中对齐
        val p6 = "居中对齐的文字内容"
        out.add(run("s6_center", listOf(textBlock(p6, uniform(p6), alignment = ReaderTextAlignment.CENTER)), config()))

        // s7：双栏
        val p7 = "双栏排版测试文字内容一二三四五六七八"
        out.add(run("s7_columns2", listOf(textBlock(p7, uniform(p7))), config(viewportWidthPx = 80, columnCount = 2)))

        // s8：字间距
        val p8 = "字间距测试文字内容"
        out.add(run("s8_letter_spacing", listOf(textBlock(p8, uniform(p8), letterSpacingPx = 1.5f)), config()))

        // s9：多块（段落 + 空行）
        val p9 = "块一文字"
        out.add(run(
            "s9_blocks",
            listOf(
                textBlock(p9, uniform(p9), position = 0),
                ReaderMeasuredBlock.BlankLine(chapterPosition = p9.length, lineHeightPx = 20f, lineSpacingMultiplier = 1f),
                textBlock(p9, uniform(p9), position = p9.length + 1),
            ),
            config(),
        ))

        // s10：章末收尾（内容刚好填满整页的边界）
        val p10 = "一二三四五六七八"
        out.add(run("s10_exact_fit", listOf(textBlock(p10, uniform(p10))), config()))


        // ---- 压力场景：长正文 + 变宽字 + 多组排版参数 ----
        val alphabet = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏"
        fun stressText(n: Int): String {
            val sb = StringBuilder(n)
            for (i in 0 until n) sb.append(alphabet[i % alphabet.length])
            return sb.toString()
        }
        fun stressWidths(t: String): FloatArray = FloatArray(t.length) { 8f + ((it * 37) % 13).toFloat() }

        val big = stressText(2000)
        val bigW = stressWidths(big)
        fun bigConfig(w: Int, h: Int, lh: Float, cols: Int, pad: Float) = ReaderPaginationConfig(
            chapterIndex = 1,
            chapterTitle = "压力测试章",
            viewportWidthPx = w,
            viewportHeightPx = h,
            paddingLeftPx = pad,
            paddingTopPx = pad,
            paddingRightPx = pad,
            paddingBottomPx = pad,
            lineHeightPx = lh,
            baselineOffsetPx = lh * 0.8f,
            paragraphSpacingPx = 4f,
            columnCount = cols,
        )

        out.add(run("s11_stress_phone", listOf(textBlock(big, bigW)), bigConfig(360, 640, 30f, 1, 20f)))
        out.add(run("s12_stress_pad", listOf(textBlock(big, bigW)), bigConfig(1080, 2400, 56f, 1, 40f)))
        out.add(run("s13_stress_2col", listOf(textBlock(big, bigW)), bigConfig(800, 1200, 40f, 2, 24f)))
        out.add(run("s14_stress_tiny", listOf(textBlock(big, bigW)), bigConfig(200, 300, 24f, 1, 10f)))

        // 多段 + 段间距
        val paras = (0 until 12).map { idx ->
            val t = stressText(180)
            textBlock(t, stressWidths(t), position = idx * 181)
        }
        out.add(run("s15_stress_paras", paras, bigConfig(360, 640, 30f, 1, 20f)))

        // 标点密集
        val punctText = stressText(600).chunked(7).joinToString("") { it + "，。" }
        out.add(run("s16_stress_punct", listOf(textBlock(punctText, stressWidths(punctText))), bigConfig(360, 640, 30f, 1, 20f)))

        println("[" + out.joinToString(",") + "]")
    }
}
