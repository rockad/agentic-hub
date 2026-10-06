import sys
import numpy as np
import pypdfium2 as pdfium
import onnxruntime
from rapidocr_onnxruntime import RapidOCR


def make_engine():
    # CUDA when the venv carries onnxruntime-gpu (setup_ocr_venv.sh installs it with an NVIDIA
    # GPU present); otherwise the CPU provider. RapidOCR silently falls back to CPU if CUDA
    # cannot initialise, so the provider actually in use is reported, not the one requested.
    cuda = "CUDAExecutionProvider" in onnxruntime.get_available_providers()
    engine = RapidOCR(det_use_cuda=cuda, cls_use_cuda=cuda, rec_use_cuda=cuda)
    # Diagnostic only -- must never be able to break OCR itself, so any shape this attribute
    # walk doesn't expect (it differs across rapidocr-onnxruntime releases, e.g. text_det vs.
    # text_detector) just falls back to an "unknown" label instead of crashing make_engine().
    used = "unknown"
    try:
        det = getattr(engine, "text_det", None) or getattr(engine, "text_detector", None)
        for attr in ("session", "infer"):  # rapidocr-onnxruntime 1.2 vs 1.4 nest the session differently
            obj = getattr(det, attr, None)
            sess = obj if hasattr(obj, "get_providers") else getattr(obj, "session", None)
            if hasattr(sess, "get_providers"):
                used = sess.get_providers()[0]
                break
    except Exception:
        pass
    print(f"ocr provider: {used}", file=sys.stderr)
    return engine


def main(pdf_path, out_path):
    engine = make_engine()
    pdf = pdfium.PdfDocument(pdf_path)
    chunks = []
    for i, page in enumerate(pdf):
        bitmap = page.render(scale=200 / 72)
        pil_image = bitmap.to_pil()
        result, _ = engine(np.array(pil_image))
        text = "\n".join([line[1] for line in result]) if result else ""
        chunks.append(f"## Page {i + 1}\n\n{text}\n")
        print(f"page {i + 1}: {len(text)} chars", file=sys.stderr)
    with open(out_path, "w") as f:
        f.write("\n".join(chunks))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
