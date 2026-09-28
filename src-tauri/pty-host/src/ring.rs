//! A fixed-capacity ring of raw terminal bytes: the last `capacity` bytes a
//! session produced, in order, so a reattaching app can replay them.

#[derive(Debug)]
pub struct Ring {
    buf: Vec<u8>,
    capacity: usize,
    /// Index of the oldest byte.
    start: usize,
    len: usize,
    total: u64,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: vec![0u8; capacity.max(1)],
            capacity: capacity.max(1),
            start: 0,
            len: 0,
            total: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Bytes held right now.
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Bytes ever pushed, including those that fell out.
    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn push(&mut self, data: &[u8]) {
        self.total += data.len() as u64;
        if data.is_empty() {
            return;
        }
        // Only the tail of a chunk larger than the ring can ever be kept.
        let data = if data.len() >= self.capacity {
            &data[data.len() - self.capacity..]
        } else {
            data
        };
        let end = (self.start + self.len) % self.capacity;
        let first = (self.capacity - end).min(data.len());
        self.buf[end..end + first].copy_from_slice(&data[..first]);
        let rest = data.len() - first;
        if rest > 0 {
            self.buf[..rest].copy_from_slice(&data[first..]);
        }
        let overflow = (self.len + data.len()).saturating_sub(self.capacity);
        self.start = (self.start + overflow) % self.capacity;
        self.len = (self.len + data.len()).min(self.capacity);
    }

    /// The held bytes, oldest first.
    pub fn contents(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.len);
        let first = (self.capacity - self.start).min(self.len);
        out.extend_from_slice(&self.buf[self.start..self.start + first]);
        if first < self.len {
            out.extend_from_slice(&self.buf[..self.len - first]);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_while_it_fits() {
        let mut r = Ring::new(16);
        r.push(b"hello ");
        r.push(b"world");
        assert_eq!(r.contents(), b"hello world");
        assert_eq!(r.len(), 11);
        assert_eq!(r.total(), 11);
    }

    #[test]
    fn keeps_only_the_newest_bytes_once_full() {
        let mut r = Ring::new(8);
        r.push(b"abcdef");
        r.push(b"ghij");
        assert_eq!(r.contents(), b"cdefghij");
        r.push(b"k");
        assert_eq!(r.contents(), b"defghijk");
        assert_eq!(r.total(), 11);
        assert_eq!(r.len(), 8);
    }

    #[test]
    fn a_chunk_larger_than_the_ring_keeps_its_tail() {
        let mut r = Ring::new(4);
        r.push(b"xy");
        r.push(b"0123456789");
        assert_eq!(r.contents(), b"6789");
        r.push(b"A");
        assert_eq!(r.contents(), b"789A");
    }

    #[test]
    fn many_small_pushes_match_a_reference_model() {
        let mut r = Ring::new(37);
        let mut model: Vec<u8> = Vec::new();
        for i in 0..500u32 {
            let chunk: Vec<u8> = (0..(i % 11) as u8)
                .map(|k| (i as u8).wrapping_add(k))
                .collect();
            r.push(&chunk);
            model.extend_from_slice(&chunk);
            if model.len() > 37 {
                model.drain(..model.len() - 37);
            }
            assert_eq!(r.contents(), model, "after push {i}");
        }
    }
}
