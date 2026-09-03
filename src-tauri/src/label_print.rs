//! Catalog print-size helpers and PDF MediaBox parsing for Instant print routing.

/// Normalize Shipping / Packages size ids to catalog checkbox ids.
pub fn normalize_print_size_id(size_id: &str) -> Option<String> {
    let id = size_id.trim().to_ascii_uppercase();
    if id.is_empty() {
        return None;
    }
    if id == "PAPER_8.27X11" || id.starts_with("PAPER_8.27X11.") {
        return Some("PAPER_8.27X11.67".into());
    }
    if id.starts_with("STOCK_4X6.75") {
        return Some("STOCK_4X6.75_LEADING_DOC_TAB".into());
    }
    Some(id)
}

/// Classify a PDF page size in inches (either orientation) → catalog id.
pub fn inches_to_catalog_size_id(width_in: f64, height_in: f64) -> Option<&'static str> {
    let short = width_in.min(height_in);
    let long = width_in.max(height_in);
    if (3.5..=4.75).contains(&short) && (5.0..=7.25).contains(&long) {
        return Some("STOCK_4X6");
    }
    if (8.0..=8.7).contains(&short) && (10.5..=12.0).contains(&long) {
        return Some("PAPER_LETTER");
    }
    None
}

/// Parse the first PDF MediaBox as inches (72 pt/in). Returns None when absent.
pub fn pdf_mediabox_inches(bytes: &[u8]) -> Option<(f64, f64)> {
    let text = String::from_utf8_lossy(bytes);
    let marker = "/MediaBox";
    let idx = text.find(marker)?;
    let after = &text[idx + marker.len()..];
    let start = after.find('[')?;
    let end = after[start..].find(']')?;
    let inner = after[start + 1..start + end].trim();
    let parts: Vec<&str> = inner.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let x0: f64 = parts[0].parse().ok()?;
    let y0: f64 = parts[1].parse().ok()?;
    let x1: f64 = parts[2].parse().ok()?;
    let y1: f64 = parts[3].parse().ok()?;
    let width_pt = (x1 - x0).abs();
    let height_pt = (y1 - y0).abs();
    if width_pt < 1.0 || height_pt < 1.0 {
        return None;
    }
    Some((width_pt / 72.0, height_pt / 72.0))
}

pub fn catalog_size_from_pdf_bytes(bytes: &[u8]) -> Option<&'static str> {
    let (w, h) = pdf_mediabox_inches(bytes)?;
    inches_to_catalog_size_id(w, h)
}

pub fn is_raw_thermal_format(print_format: Option<&str>, file_name: &str) -> bool {
    let fmt = print_format.unwrap_or("").trim().to_ascii_uppercase();
    if matches!(fmt.as_str(), "ZPL" | "ZPLII" | "EPL") {
        return true;
    }
    let lower = file_name.to_ascii_lowercase();
    lower.ends_with(".zpl") || lower.ends_with(".zplii") || lower.ends_with(".epl")
}

pub fn is_image_label(mime: Option<&str>, file_name: &str) -> bool {
    if mime.is_some_and(|m| m.to_ascii_lowercase().starts_with("image/")) {
        return true;
    }
    let lower = file_name.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".bmp")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_size_aliases() {
        assert_eq!(
            normalize_print_size_id("PAPER_8.27X11").as_deref(),
            Some("PAPER_8.27X11.67")
        );
        assert_eq!(
            normalize_print_size_id("STOCK_4X6.75_LEFT").as_deref(),
            Some("STOCK_4X6.75_LEADING_DOC_TAB")
        );
        assert_eq!(
            normalize_print_size_id("STOCK_4X6").as_deref(),
            Some("STOCK_4X6")
        );
        assert_eq!(normalize_print_size_id(""), None);
    }

    #[test]
    fn mediabox_inches_and_catalog_size() {
        let pdf = b"%PDF-1.4\n/MediaBox [0 0 288 432]\n";
        let inches = pdf_mediabox_inches(pdf).expect("mediabox");
        assert!((inches.0 - 4.0).abs() < 0.01);
        assert!((inches.1 - 6.0).abs() < 0.01);
        assert_eq!(catalog_size_from_pdf_bytes(pdf), Some("STOCK_4X6"));

        let letter = b"%PDF-1.4\n/MediaBox [0 0 612 792]\n";
        assert_eq!(catalog_size_from_pdf_bytes(letter), Some("PAPER_LETTER"));
    }

    #[test]
    fn raw_format_detection() {
        assert!(is_raw_thermal_format(Some("ZPL"), "label.pdf"));
        assert!(is_raw_thermal_format(None, "label.zpl"));
        assert!(!is_raw_thermal_format(Some("PDF"), "label.pdf"));
    }
}
