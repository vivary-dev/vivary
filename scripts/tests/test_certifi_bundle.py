"""Offline preservation and integrity regressions for the narrow pip overlay."""
import base64
import csv
import hashlib
import io
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest import mock
import zipfile

policy = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'certifi_bundle.py'))
# runpy functions keep the module globals, not the returned shallow dictionary.
g = policy['patched_pip_bytes'].__globals__


def archive(members):
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w') as z:
        for name, data in members.items():
            z.writestr(zipfile.ZipInfo(name, (2026, 10, 23, 0, 0, 0)), data)
    return result.getvalue()


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.members = {'pip/_vendor/certifi/__init__.py': b'old version',
                        'pip/_vendor/certifi/cacert.pem': b'old CA',
                        'pip/_vendor/certifi/core.py': b'vendored import rewrites',
                        'pip/_vendor/distlib/scripts.py': b'preserved launcher code',
                        'pip/_vendor/vendor.txt': b'    certifi==2026.10.19\n',
                        'pip-26.2.2.dist-info/RECORD': b'old record'}
        self.pip = archive(self.members)
        self.certifi = archive({'certifi/__init__.py': b'new version', 'certifi/cacert.pem': b'new CA'})
        patch = mock.patch.dict(g, PIP_SHA256=hashlib.sha256(self.pip).hexdigest(),
                                CERTIFI_SIZE=len(self.certifi), CERTIFI_SHA256=hashlib.sha256(self.certifi).hexdigest())
        patch.start()
        self.addCleanup(patch.stop)

    def test_only_selected_files_change_and_record_authenticates_every_member(self):
        derive = policy['patched_pip_bytes']
        result = derive(self.pip, self.certifi)
        self.assertEqual(result, derive(self.pip, self.certifi))
        with zipfile.ZipFile(io.BytesIO(result)) as z:
            changed = {name for name in z.namelist() if z.read(name) != self.members[name]}
            self.assertEqual(changed, {'pip/_vendor/certifi/__init__.py', 'pip/_vendor/certifi/cacert.pem',
                                       'pip/_vendor/vendor.txt', 'pip-26.2.2.dist-info/RECORD'})
            for name, digest, size in csv.reader(io.StringIO(z.read('pip-26.2.2.dist-info/RECORD').decode())):
                if name.endswith('/RECORD'):
                    self.assertEqual((digest, size), ('', ''))
                else:
                    data = z.read(name)
                    self.assertEqual(size, str(len(data)))
                    self.assertEqual(digest, 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode())

    def test_each_input_tamper_refuses_before_zip_parsing(self):
        for pip, certifi in ((self.pip+b'!', self.certifi), (self.pip, self.certifi+b'!')):
            with self.subTest(pip_changed=pip != self.pip), mock.patch.object(g['zipfile'], 'ZipFile') as parse:
                with self.assertRaises(ValueError):
                    policy['patched_pip_bytes'](pip, certifi)
                parse.assert_not_called()

    def test_cached_derived_wheel_rechecks_inputs_and_refuses_changed_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pip, cert, target = root/'original.whl', root/'cert.whl', root/'derived.whl'
            pip.write_bytes(self.pip); cert.write_bytes(self.certifi)
            prepare = policy['prepare_pip']
            self.assertEqual(prepare(pip, cert, target), target)
            first = target.read_bytes()
            self.assertEqual(prepare(pip, cert, target).read_bytes(), first)
            target.write_bytes(first+b'!')
            with self.assertRaises(ValueError): prepare(pip, cert, target)
            target.unlink(); target.symlink_to(pip)
            with self.assertRaises(ValueError): prepare(pip, cert, target)

    def test_filter_removes_only_selected_der_and_preserves_order(self):
        def pem(data):
            return b'-----BEGIN CERTIFICATE-----\n'+base64.b64encode(data)+b'\n-----END CERTIFICATE-----'
        remove, keep = pem(b'removed DER'), pem(b'preserved DER')
        with mock.patch.dict(g, EXCLUDED_CA_SHA256={hashlib.sha256(b'removed DER').hexdigest()}):
            self.assertEqual(policy['filtered_ca_bytes'](keep+b'\n'+remove+b'\n'+keep), keep+b'\n'+keep+b'\n')
            with self.assertRaises(ValueError): policy['filtered_ca_bytes'](remove)
            with self.assertRaises(ValueError): policy['filtered_ca_bytes'](b'no certificates')


if __name__ == '__main__': unittest.main()
