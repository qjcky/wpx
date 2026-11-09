//! Счётчики байтов сетевого адаптера по его имени (alias): в Windows — через
//! GetIfTable2, в Linux — из /sys/class/net. sysinfo виртуальный TUN-адаптер
//! не показывает, поэтому читаем напрямую.

/// (принято, отправлено) байт с момента появления адаптера; None — не найден.
#[cfg(not(windows))]
pub fn octets(alias: &str) -> Option<(u64, u64)> {
    if alias.contains('/') {
        return None;
    }
    let d = std::path::Path::new("/sys/class/net").join(alias).join("statistics");
    let n = |f: &str| std::fs::read_to_string(d.join(f)).ok()?.trim().parse::<u64>().ok();
    Some((n("rx_bytes")?, n("tx_bytes")?))
}

/// (принято, отправлено) байт с момента появления адаптера; None — не найден.
#[cfg(windows)]
pub fn octets(alias: &str) -> Option<(u64, u64)> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
    let want: Vec<u16> = alias.encode_utf16().collect();
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    // SAFETY: GetIfTable2 выделяет таблицу сам; освобождаем через FreeMibTable.
    unsafe {
        if GetIfTable2(&mut table) != 0 || table.is_null() {
            return None;
        }
        let n = (*table).NumEntries as usize;
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), n);
        let found = rows.iter().find(|r| {
            let len = r.Alias.iter().position(|&c| c == 0).unwrap_or(r.Alias.len());
            r.Alias[..len] == want[..]
        });
        let res = found.map(|r| (r.InOctets, r.OutOctets));
        FreeMibTable(table as *const _);
        res
    }
}
