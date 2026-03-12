<?php
declare(strict_types=1);

namespace SOSPrescription;

final class Db
{
    public static function table(string $name): string
    {
        global $wpdb;
        return $wpdb->prefix . 'sosprescription_' . $name;
    }
}
