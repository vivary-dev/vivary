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

    def test_windows_exports_only_eligible_root_anchors_minus_distrust_and_policy(self):
        server_auth = g['ssl'].Purpose.SERVER_AUTH.oid
        certificates = [
            (b'all purposes', 'x509_asn', True),
            (b'server only', 'x509_asn', frozenset({server_auth})),
            (b'all purposes', 'x509_asn', True),
            (b'client only', 'x509_asn', frozenset({'1.3.6.1.5.5.7.3.2'})),
            (b'no purposes', 'x509_asn', frozenset()),
            (b'false trust', 'x509_asn', False),
            (b'not X509', 'pkcs_7_asn', True),
            (b'explicitly distrusted', 'x509_asn', True),
            (b'policy removed', 'x509_asn', True),
        ]
        def enumerate_store(name):
            if name == 'Disallowed':
                return [(b'explicitly distrusted', 'x509_asn', True)]
            self.assertEqual(name, 'ROOT', 'intermediate CA entries must never become anchors')
            return certificates
        with mock.patch.object(g['sys'], 'platform', 'win32'), \
                mock.patch.object(g['ssl'], 'enum_certificates', side_effect=enumerate_store, create=True) as stores, \
                mock.patch.dict(g, EXCLUDED_CA_SHA256={hashlib.sha256(b'policy removed').hexdigest()}):
            first = policy['host_ca_bytes']()
            self.assertEqual(first, policy['host_ca_bytes']())
        expected = sorted((b'all purposes', b'server only'), key=lambda value: hashlib.sha256(value).hexdigest())
        self.assertEqual(first, b''.join(g['ssl'].DER_cert_to_PEM_cert(value).encode() for value in expected))
        self.assertEqual(stores.call_args_list, [mock.call('Disallowed'), mock.call('ROOT')] * 2)

    def test_windows_host_export_refuses_enumeration_failure_empty_roots_and_source_override(self):
        with mock.patch.object(g['sys'], 'platform', 'win32'), \
                mock.patch.object(g['ssl'], 'enum_certificates', create=True) as stores:
            with self.assertRaises(ValueError): policy['host_ca_bytes'](Path('/caller/anchors.pem'))
            stores.assert_not_called()
            stores.side_effect = PermissionError('inert store failure')
            with self.assertRaises(PermissionError): policy['host_ca_bytes']()
            stores.side_effect = None
            stores.return_value = []
            with self.assertRaisesRegex(ValueError, 'eligible server-auth'): policy['host_ca_bytes']()

    def test_linux_host_export_reuses_the_removal_only_filter(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'existing-ca.pem'
            source.write_bytes(b'original host CA fixture')
            with mock.patch.object(g['sys'], 'platform', 'linux'), \
                    mock.patch.dict(g, filtered_ca_bytes=mock.Mock(return_value=b'filtered PEM')):
                self.assertEqual(policy['host_ca_bytes'](source), b'filtered PEM')
                g['filtered_ca_bytes'].assert_called_once_with(b'original host CA fixture')


if __name__ == '__main__': unittest.main()
